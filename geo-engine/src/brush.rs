//! The freehand brush centreline as a STREAM (t158 locality fix).
//!
//! A brush stroke is drawn live, one pointer sample at a time, so its centreline is built the same
//! way: each pushed point may only change a short PROVISIONAL TAIL just behind the pen. Everything
//! before that tail is FROZEN — computed once, never revisited — so the live preview never visibly
//! reshapes the stroke far behind the pen, and the total work over a stroke is linear.
//!
//! Pipeline, all causal:
//! 1. **Dedupe** exact repeats (Safari doubles every Pencil move).
//! 2. **Online thinning.** A point becomes a control point once it is `step` from the last one.
//!    Slow drawing delivers points 1–3 px apart whose sub-pixel jitter swings the direction
//!    10–15° per point; spacing the controls out smooths that wobble. Shape is kept: when the
//!    chord from the last control to the newest point would pass farther than `tol` from any point
//!    in between (a hook or sharp corner), the previous point is kept instead.
//! 3. **Quadratic B-spline** through the controls (Chaikin's limit curve): each piece runs from the
//!    midpoint of one control span to the next, bent toward the control between them. A piece
//!    depends only on its three controls, so it is final as soon as the control after it is final.
//!    It never overshoots (convex hull). A **sharp turn** (> 60°) doubles its control, which makes
//!    the curve pass exactly through it as a corner — a round brush then rounds it naturally.
//!
//! The tail is the last piece's half span plus the open span to the pen: at most ~1.5 `step`.
//! `step` is derived from the tail budget, so the tail length is THE knob.
//! `brush_centerline` (stored geometry) is the stream run over the whole stroke — the live
//! preview's last frame and the stored outline are the same curve by construction.

use crate::seg_dist;

/// The provisional tail behind the pen, in brush radii (Christian, 2026-10-10: about one span — a
/// brush width — maybe as little as the radius; never zero). Only this much of the live stroke
/// can still change as new points arrive.
pub const BRUSH_TAIL_RADII: f64 = 2.0;

/// Shape tolerance for thinning, in brush radii: no raw point lies farther than this from the
/// control polygon (a hook or corner keeps its extra control point).
const BRUSH_THIN_TOL_RADII: f64 = 0.25;

/// A control is a corner (doubled, curve passes through it) when the turn there is sharper than
/// 60° — well above slow-drawing jitter (≤ ~20° between spaced controls).
const BRUSH_CORNER_COS: f64 = 0.5;

/// Centreline sampling: one sample per this many brush radii of curve, capped per piece.
const BRUSH_SAMPLE_RADII: f64 = 0.5;
const BRUSH_MAX_SUBDIV: usize = 32;

/// Raw points held in the open span before one is kept regardless — bounds the per-point cost of
/// the tolerance check when the pen dwells (jittering in place) for a long time.
const BRUSH_MAX_SPAN_POINTS: usize = 64;

fn mid(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn is_corner(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> bool {
    let (d1, d2) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
    let (l1, l2) = (d1[0].hypot(d1[1]), d2[0].hypot(d2[1]));
    l1 > 1e-9 && l2 > 1e-9 && (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) < BRUSH_CORNER_COS
}

/// The samples of piece `i` of the open quadratic B-spline over controls `c`, EXCLUDING the
/// piece's start point (the previous piece already ended there). Piece 0 is the straight lead from
/// `c[0]`; piece i in 1..len-1 is the quadratic from mid(c[i-1], c[i]) via c[i] to mid(c[i], c[i+1]);
/// piece len-1 is the straight run into the last control.
fn piece(c: &[[f64; 2]], i: usize, sample: f64, out: &mut Vec<[f64; 2]>) {
    let n = c.len();
    let (a, ctrl, b) = if i == 0 {
        (c[0], None, if n > 1 { mid(c[0], c[1]) } else { c[0] })
    } else if i == n - 1 {
        (mid(c[n - 2], c[n - 1]), None, c[n - 1])
    } else {
        (mid(c[i - 1], c[i]), Some(c[i]), mid(c[i], c[i + 1]))
    };
    let len = match ctrl {
        Some(m) => dist(a, m) + dist(m, b),
        None => dist(a, b),
    };
    if len < 1e-9 {
        return;
    }
    let k = ((len / sample).ceil() as usize).clamp(1, BRUSH_MAX_SUBDIV);
    for j in 1..=k {
        let u = j as f64 / k as f64;
        out.push(match ctrl {
            Some(m) => {
                let (w0, w1, w2) = ((1.0 - u) * (1.0 - u), 2.0 * u * (1.0 - u), u * u);
                [w0 * a[0] + w1 * m[0] + w2 * b[0], w0 * a[1] + w1 * m[1] + w2 * b[1]]
            }
            None => [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])],
        });
    }
}

/// An in-progress brush centreline. `push` raw points as they arrive; `frozen()` only ever grows,
/// `tail()` is the provisional rest of the curve up to the pen.
pub struct BrushStream {
    step: f64,
    tol: f64,
    sample: f64,
    /// Final control points (corners doubled). Append-only.
    ctrl: Vec<[f64; 2]>,
    /// Raw points since the last control (exclusive). Its last entry is the pen.
    span: Vec<[f64; 2]>,
    frozen: Vec<[f64; 2]>,
    /// Spline pieces already emitted into `frozen`.
    pieces_done: usize,
    tail: Vec<[f64; 2]>,
}

impl BrushStream {
    pub fn new(size: f64) -> Self {
        let r = size.max(0.0) / 2.0;
        Self::with_tail(size, r * BRUSH_TAIL_RADII)
    }

    /// A stream whose provisional tail is at most ~`tail` long (image px).
    pub fn with_tail(size: f64, tail: f64) -> Self {
        let r = size.max(0.0) / 2.0;
        BrushStream {
            step: (tail / 1.5).max(1e-6),
            tol: r * BRUSH_THIN_TOL_RADII,
            sample: (r * BRUSH_SAMPLE_RADII).max(0.5),
            ctrl: Vec::new(),
            span: Vec::new(),
            frozen: Vec::new(),
            pieces_done: 0,
            tail: Vec::new(),
        }
    }

    pub fn frozen(&self) -> &[[f64; 2]] {
        &self.frozen
    }

    pub fn tail(&self) -> &[[f64; 2]] {
        &self.tail
    }

    pub fn push(&mut self, p: [f64; 2]) {
        let last = self.span.last().or(self.ctrl.last());
        if matches!(last, Some(q) if (p[0] - q[0]).abs() < 1e-9 && (p[1] - q[1]).abs() < 1e-9) {
            return;
        }
        if self.ctrl.is_empty() {
            self.keep(p);
            self.frozen.push(p);
        } else {
            self.span.push(p);
            let anchor = *self.ctrl.last().unwrap();
            let n = self.span.len();
            let bent = n > 1 && self.span[..n - 1].iter().any(|&q| seg_dist(q, anchor, p) > self.tol);
            if bent {
                // The chord to the pen would cut a hook/corner: keep the point before the pen.
                self.keep_span(n - 2);
            }
            let anchor = *self.ctrl.last().unwrap();
            if dist(anchor, p) >= self.step || self.span.len() >= BRUSH_MAX_SPAN_POINTS {
                self.keep_span(self.span.len() - 1);
            }
            self.freeze();
        }
        self.retail();
    }

    /// Make open-span point `i` a final control; the span restarts after it.
    fn keep_span(&mut self, i: usize) {
        let p = self.span[i];
        self.keep(p);
        self.span.drain(..=i);
    }

    /// Append `p` as a final control, doubling the previous control if the turn there is a corner.
    fn keep(&mut self, p: [f64; 2]) {
        let n = self.ctrl.len();
        if n >= 2 && is_corner(self.ctrl[n - 2], self.ctrl[n - 1], p) {
            let c = self.ctrl[n - 1];
            self.ctrl.push(c);
        }
        self.ctrl.push(p);
    }

    /// Emit every piece that depends only on final controls: piece i needs ctrl[i+1].
    fn freeze(&mut self) {
        while self.ctrl.len() >= 2 && self.pieces_done + 1 < self.ctrl.len() {
            // Piece i of the FINAL control sequence; i+1 < len, so it is never the end run.
            let i = self.pieces_done;
            let c = &self.ctrl[i.saturating_sub(1)..i + 2];
            piece(c, i.min(1), self.sample, &mut self.frozen);
            self.pieces_done += 1;
        }
    }

    /// Recompute the provisional tail: the pieces after the frozen ones, through the pen.
    fn retail(&mut self) {
        self.tail.clear();
        let n = self.ctrl.len();
        let from = self.pieces_done.saturating_sub(1);
        let mut c: Vec<[f64; 2]> = self.ctrl[from..].to_vec();
        if let Some(&pen) = self.span.last() {
            if n >= 2 && is_corner(self.ctrl[n - 2], self.ctrl[n - 1], pen) {
                c.push(self.ctrl[n - 1]);
            }
            c.push(pen);
        }
        let first = self.pieces_done - from;
        for i in first..c.len() {
            piece(&c, i, self.sample, &mut self.tail);
        }
    }

    /// The whole centreline so far: frozen, then the tail.
    pub fn line(&self) -> Vec<[f64; 2]> {
        let mut out = self.frozen.clone();
        out.extend_from_slice(&self.tail);
        out
    }
}

/// The brush stroke's centreline: the stream run over every point. This is what the stored
/// outline is built from, and exactly what the live preview showed after the last point.
pub fn brush_centerline(points: &[[f64; 2]], size: f64) -> Vec<[f64; 2]> {
    let mut s = BrushStream::new(size);
    for p in points {
        s.push(*p);
    }
    s.line()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arc(line: &[[f64; 2]]) -> f64 {
        line.windows(2).map(|w| dist(w[0], w[1])).sum()
    }

    /// Distance from `p` to the polyline `line`.
    fn to_line(p: [f64; 2], line: &[[f64; 2]]) -> f64 {
        if line.len() == 1 {
            return dist(p, line[0]);
        }
        line.windows(2).map(|w| seg_dist(p, w[0], w[1])).fold(f64::INFINITY, f64::min)
    }

    /// Strokes that stress the stream: slow wobbly, a slow sharp hook, a fast right angle, a
    /// tight slow circle, and a dwell (pen jittering in place).
    fn strokes() -> Vec<Vec<[f64; 2]>> {
        let wobbly: Vec<_> = (0..200)
            .map(|i| {
                let x = i as f64 * 1.5;
                [x, 0.8 * (2.0 * std::f64::consts::PI * x / 12.0).sin()]
            })
            .collect();
        let mut hook: Vec<_> = (0..60).map(|i| [i as f64 * 1.5, 0.0]).collect();
        hook.extend((1..12).map(|i| [88.5 - i as f64 * 1.2, i as f64 * 1.2]));
        let fast = vec![[0.0, 0.0], [22.0, 0.0], [44.0, 0.0], [44.0, 22.0], [44.0, 44.0], [22.0, 50.0]];
        let circle: Vec<_> = (0..240)
            .map(|i| {
                let a = i as f64 * 0.03;
                [30.0 * a.cos(), 30.0 * a.sin()]
            })
            .collect();
        let mut dwell: Vec<_> = (0..20).map(|i| [i as f64 * 2.0, 0.0]).collect();
        dwell.extend((0..300).map(|i| [38.0 + 0.3 * (i as f64).sin(), 0.3 * (i as f64 * 1.7).cos()]));
        dwell.extend((0..20).map(|i| [40.0 + i as f64 * 2.0, 0.0]));
        vec![wobbly, hook, fast, circle, dwell]
    }

    /// The locality contract: pushing a point never changes any frozen point (frozen only grows),
    /// and the provisional tail never exceeds the tail budget (plus the pen's own last jump, which
    /// no algorithm can avoid). Checked for the default and for a radius-sized tail.
    #[test]
    fn frozen_only_grows_and_tail_stays_within_budget() {
        let size = 16.0;
        for tail_radii in [BRUSH_TAIL_RADII, 1.0] {
            let budget = size / 2.0 * tail_radii;
            for pts in strokes() {
                let mut s = BrushStream::with_tail(size, budget);
                let mut prev: Vec<[f64; 2]> = Vec::new();
                for (k, p) in pts.iter().enumerate() {
                    s.push(*p);
                    assert!(s.frozen().starts_with(&prev), "frozen prefix changed at point {k}");
                    prev = s.frozen().to_vec();
                    let jump = if k > 0 { dist(*p, pts[k - 1]) } else { 0.0 };
                    let t = arc(s.tail());
                    assert!(t <= budget + jump + 1e-6, "tail {t:.2} > budget {budget} (+jump {jump:.2}) at {k}");
                }
            }
        }
    }

    /// The curve keeps the drawn shape: every raw point stays within half a radius of the
    /// centreline (so a round brush always covers it with room to spare), incl. hooks/corners.
    #[test]
    fn centreline_stays_close_to_every_raw_point() {
        let size = 16.0;
        for pts in strokes() {
            let line = brush_centerline(&pts, size);
            for p in &pts {
                let d = to_line(*p, &line);
                assert!(d <= size / 4.0, "raw point {p:?} is {d:.2} from the centreline");
            }
            assert_eq!(line.first(), pts.first());
            assert_eq!(line.last(), pts.last());
        }
    }

    /// A sharp corner is a corner: the curve passes through the apex instead of cutting it.
    #[test]
    fn sharp_corner_passes_through_apex() {
        let pts = vec![[0.0, 0.0], [22.0, 0.0], [44.0, 0.0], [44.0, 22.0], [44.0, 44.0]];
        let line = brush_centerline(&pts, 16.0);
        assert!(to_line([44.0, 0.0], &line) < 1e-6);
    }

    /// Thinning really happens on slow input (the jitter smoothing), and exact repeats are no-ops.
    #[test]
    fn slow_input_is_thinned_and_repeats_ignored() {
        let pts = &strokes()[0];
        let mut s = BrushStream::new(16.0);
        for p in pts {
            s.push(*p);
            s.push(*p);
        }
        assert!(s.ctrl.len() < pts.len() / 4, "kept {} controls of {}", s.ctrl.len(), pts.len());
        assert_eq!(s.line(), brush_centerline(pts, 16.0));
    }
}
