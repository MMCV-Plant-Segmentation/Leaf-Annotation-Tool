//! geo-engine — shared stroke-geometry engine (t96/t103 Phase B).
//!
//! Two operations, both driven through a single JSON-over-linear-memory WASM ABI so the leaf FE
//! (browser `WebAssembly`) and BE (`wasmtime-py`) call the exact same code:
//!
//! - `outline`: turn a raw stroke (polyline w/ per-vertex radius, or freehand brush points) into
//!   filled ring(s).
//! - `fuse`: union a set of polygons, repairing self-intersections and dropping interior holes,
//!   on `i_overlay`'s **integer** boolean core (quantized to a fixed grid finer than 1/100 px so
//!   the core is exact).
//!
//! ## Request/response JSON contract
//! Request (tagged by `"op"`):
//! ```json
//! { "op": "outline", "kind": "polyline", "points": [[x,y],...], "radii": [r,...] }
//! { "op": "outline", "kind": "brush",    "points": [[x,y],...], "size": w }
//! { "op": "fuse",    "polygons": [[[x,y],...], ...] }
//! ```
//! Response: `{ "rings": [[[x,y],...], ...] }` on success, `{ "error": "..." }` on failure.
//!
//! ## WASM ABI
//! Raw exports over linear memory (no wasm-bindgen/JS glue):
//! - `alloc(len: u32) -> ptr: u32` — caller allocates a buffer, writes the request JSON into it.
//! - `dealloc(ptr: u32, len: u32)` — caller frees a buffer it allocated (request or response).
//! - `process(req_ptr: u32, req_len: u32) -> resp_ptr: u32` — response is a `u32`-LE length
//!   prefix followed by UTF-8 JSON at `resp_ptr`. Total response byte length is `4 + length`; the
//!   caller must `dealloc(resp_ptr, 4 + length)` when done.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{Overlay, ShapeType};
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;
use serde::{Deserialize, Serialize};

/// Integer grid scale: 1 float unit == `SCALE` integer units. Finer than 1/100 px (1024 > 100)
/// so the quantization error is well below anything visually meaningful, while staying an
/// integer power of two so quantize/dequantize round-trips are exact for the common case.
const SCALE: f64 = 1024.0;

/// Number of segments used to approximate a circle (vertex/cap disk) as a polygon.
const CIRCLE_SEGMENTS: usize = 32;

/// cos threshold above which a polyline vertex counts as "straight enough" to SKIP its round-join
/// disk — the tangent quads already cover a straight run, so an interior near-collinear disk is pure
/// redundant work (t140). cos(2.5°) ≈ 0.99905, so anything straighter than ~2.5° is skipped.
const TURN_COS: f64 = 0.999;

/// True when the direction changes appreciably at `b` (segment a→b vs b→c) — a visible round join
/// whose disk matters. Near-collinear vertices return false (their disk is redundant with the quads).
fn significant_turn(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> bool {
    let (d1x, d1y) = (b[0] - a[0], b[1] - a[1]);
    let (d2x, d2y) = (c[0] - b[0], c[1] - b[1]);
    let l1 = (d1x * d1x + d1y * d1y).sqrt();
    let l2 = (d2x * d2x + d2y * d2y).sqrt();
    if l1 < 1e-9 || l2 < 1e-9 {
        return true; // degenerate/coincident → keep the disk (cheap safety)
    }
    (d1x * d2x + d1y * d2y) / (l1 * l2) < TURN_COS
}

// ---------------------------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------------------------

#[inline]
fn quantize(p: [f64; 2]) -> IntPoint {
    IntPoint::new((p[0] * SCALE).round() as i32, (p[1] * SCALE).round() as i32)
}

#[inline]
fn dequantize(p: IntPoint) -> [f64; 2] {
    [p.x as f64 / SCALE, p.y as f64 / SCALE]
}

fn quantize_contour(points: &[[f64; 2]]) -> Vec<IntPoint> {
    points.iter().copied().map(quantize).collect()
}

fn dequantize_contour(points: &[IntPoint]) -> Vec<[f64; 2]> {
    points.iter().copied().map(dequantize).collect()
}

// ---------------------------------------------------------------------------------------------
// fuse: union + self-intersection repair + hole-drop, on the integer core.
// ---------------------------------------------------------------------------------------------

/// Union `polygons` (each an outer contour, no holes expected on input — but self-intersecting
/// input, e.g. a bowtie, is repaired), drop any interior holes produced by the union, and return
/// the resulting outer ring(s). Disjoint input polygons produce multiple output rings.
pub fn fuse_polygons(polygons: &[Vec<[f64; 2]>]) -> Vec<Vec<[f64; 2]>> {
    let total_points: usize = polygons.iter().map(|p| p.len()).sum();
    let mut overlay = Overlay::new(total_points);
    for polygon in polygons {
        if polygon.len() < 3 {
            continue;
        }
        let contour = quantize_contour(polygon);
        overlay.add_contour(&contour, ShapeType::Subject);
    }

    // `Subject`-only overlay with no `Clip` resolves self-intersections and unions all subject
    // contours together per the fill rule — exactly the "fuse" semantics we want.
    let shapes = overlay.overlay(OverlayRule::Subject, FillRule::NonZero);

    shapes
        .into_iter()
        .filter_map(|shape| shape.into_iter().next()) // outer contour only — drop holes.
        .map(|contour| dequantize_contour(&contour))
        .filter(|ring| ring.len() >= 3)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// outline: polyline (round joins/caps, per-vertex radius) and brush (freedraw).
// ---------------------------------------------------------------------------------------------

/// Build a regular polygon approximating a circle of radius `r` centered at `c`.
fn circle_polygon(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    let mut points = Vec::with_capacity(CIRCLE_SEGMENTS);
    for i in 0..CIRCLE_SEGMENTS {
        let angle = 2.0 * std::f64::consts::PI * (i as f64) / (CIRCLE_SEGMENTS as f64);
        points.push([c[0] + r * angle.cos(), c[1] + r * angle.sin()]);
    }
    points
}

/// The convex quad connecting the external tangent lines of two circles (c0, r0) and (c1, r1).
/// This is the "cone frustum" silhouette of a segment whose two ends have different radii; when
/// `r0 == r1` it degenerates to a rectangle. Returns `None` when the circles coincide or one
/// fully contains the other (no external tangent line exists) — in that case the circle disks
/// already added separately provide adequate coverage.
fn tangent_quad(c0: [f64; 2], r0: f64, c1: [f64; 2], r1: f64) -> Option<Vec<[f64; 2]>> {
    let dx = c1[0] - c0[0];
    let dy = c1[1] - c0[1];
    let dist = (dx * dx + dy * dy).sqrt();
    if dist < 1e-9 {
        return None;
    }
    let ratio = ((r0 - r1) / dist).clamp(-1.0, 1.0);
    let gamma = ratio.acos();
    let angle = dy.atan2(dx);
    let a1 = angle + gamma;
    let a2 = angle - gamma;

    let t0a = [c0[0] + r0 * a1.cos(), c0[1] + r0 * a1.sin()];
    let t1a = [c1[0] + r1 * a1.cos(), c1[1] + r1 * a1.sin()];
    let t1b = [c1[0] + r1 * a2.cos(), c1[1] + r1 * a2.sin()];
    let t0b = [c0[0] + r0 * a2.cos(), c0[1] + r0 * a2.sin()];

    // `circle_polygon` winds CCW (standard math orientation); this quad must match so the union
    // fills consistently under `FillRule::NonZero` — mismatched winding cancels the overlap
    // instead of merging it, fragmenting the outline into multiple rings.
    let quad = vec![t0a, t1a, t1b, t0b];
    let signed_area: f64 = {
        let n = quad.len();
        let mut sum = 0.0;
        for i in 0..n {
            let (x0, y0) = (quad[i][0], quad[i][1]);
            let (x1, y1) = (quad[(i + 1) % n][0], quad[(i + 1) % n][1]);
            sum += x0 * y1 - x1 * y0;
        }
        sum
    };
    let quad = if signed_area < 0.0 {
        quad.into_iter().rev().collect()
    } else {
        quad
    };

    Some(quad)
}

/// Outline a polyline stroke with per-vertex half-width (radius). Produces round joins (the
/// per-vertex circle disks) and round caps (the circle disks at the first/last vertex) by
/// unioning every vertex circle with every segment's tangent quad.
pub fn outline_polyline(points: &[[f64; 2]], radii: &[f64]) -> Vec<Vec<[f64; 2]>> {
    if points.is_empty() || points.len() != radii.len() {
        return Vec::new();
    }

    if points.len() == 1 {
        return fuse_polygons(&[circle_polygon(points[0], radii[0].max(0.0))]);
    }

    let n = points.len();
    let mut pieces: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n * 2);
    // Round-join / cap disks ONLY at the endpoints and at real corners — a straight run's interior
    // disks are already covered by the tangent quads, so stamping one at every vertex is the t140
    // cost. Same shape (the quads carry the straight parts; disks round the actual turns).
    for i in 0..n {
        if i == 0 || i == n - 1 || significant_turn(points[i - 1], points[i], points[i + 1]) {
            pieces.push(circle_polygon(points[i], radii[i].max(0.0)));
        }
    }
    for i in 0..n - 1 {
        if let Some(quad) = tangent_quad(points[i], radii[i].max(0.0), points[i + 1], radii[i + 1].max(0.0)) {
            pieces.push(quad);
        }
    }

    fuse_polygons(&pieces)
}

/// Shoelace polygon area (unsigned).
fn ring_area(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let mut sum = 0.0;
    for i in 0..n {
        let (x0, y0) = (ring[i][0], ring[i][1]);
        let (x1, y1) = (ring[(i + 1) % n][0], ring[(i + 1) % n][1]);
        sum += x0 * y1 - x1 * y0;
    }
    (sum / 2.0).abs()
}

/// Keep only the largest-by-area ring, discarding negligible artifact rings — used where the
/// result is conceptually a single contiguous shape (a brush stroke).
fn largest_ring_by_area(rings: Vec<Vec<[f64; 2]>>) -> Vec<Vec<[f64; 2]>> {
    match rings
        .into_iter()
        .max_by(|a, b| ring_area(a).partial_cmp(&ring_area(b)).unwrap_or(std::cmp::Ordering::Equal))
    {
        Some(ring) => vec![ring],
        None => Vec::new(),
    }
}

/// Outline a freehand brush stroke via `freedraw` (a Rust port of perfect-freehand).
pub fn outline_brush(points: &[[f64; 2]], size: f64) -> Vec<Vec<[f64; 2]>> {
    if points.is_empty() {
        return Vec::new();
    }

    let input: Vec<freedraw::InputPoint> = points
        .iter()
        .map(|p| freedraw::InputPoint::Array([p[0], p[1]], None))
        .collect();

    let options = freedraw::StrokeOptions {
        size: Some(size.max(0.0)),
        thinning: Some(0.0),
        smoothing: Some(0.5),
        simulate_pressure: Some(false),
        ..Default::default()
    };

    let outline = freedraw::get_stroke(&input, &options);

    // `freedraw`'s ported stroke-outline algorithm can round sharp corners and cap orientation
    // tightly enough that it doesn't strictly contain every input sample (most visible at the
    // caps and at sharp direction changes) — fuse in a disk of the stroke's half-width at every
    // input point so the outline always contains the whole input path, using the same
    // integer-core union as `fuse_polygons`/`outline_polyline`.
    let radius = size.max(0.0) / 2.0;
    let mut pieces: Vec<Vec<[f64; 2]>> = Vec::with_capacity(points.len() + 1);
    if outline.len() >= 3 {
        pieces.push(outline);
    }
    // Coverage disks: freedraw's ribbon covers dense input but can short-ribbon on long/straight runs.
    // Instead of a full disk at EVERY sample (the t140 cost), add one every ~radius of arc length (+
    // both endpoints). Spacing ≤ radius keeps consecutive disks overlapping, so a far disk can never
    // disconnect and get dropped by `largest_ring_by_area` (the sparse/collinear coverage bug). Same
    // shape — freedraw's outline is unchanged; these only guarantee containment.
    let step = (radius * 0.34).max(1.0);
    let last = points.len() - 1;
    let mut acc = step; // force a disk at the first point
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            let (dx, dy) = (p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
            acc += (dx * dx + dy * dy).sqrt();
        }
        if i == 0 || i == last || acc >= step {
            pieces.push(circle_polygon(*p, radius));
            acc = 0.0;
        }
    }

    // `freedraw`'s ported outline can leave a tiny self-intersection sliver (a near-zero-area
    // artifact ring) near sharp direction changes; a brush stroke is conceptually one contiguous
    // shape, so keep only the largest ring by area and drop any negligible artifacts.
    largest_ring_by_area(fuse_polygons(&pieces))
}

// ---------------------------------------------------------------------------------------------
// JSON request/response ABI
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Outline {
        kind: String,
        points: Vec<[f64; 2]>,
        #[serde(default)]
        radii: Option<Vec<f64>>,
        #[serde(default)]
        size: Option<f64>,
    },
    Fuse {
        polygons: Vec<Vec<[f64; 2]>>,
    },
    /// Self-identification, so a caller can prove which engine it is actually running
    /// (runtime drift detection — a build step only catches drift at build time).
    Version,
}

#[derive(Serialize)]
struct RingsResponse {
    rings: Vec<Vec<[f64; 2]>>,
}

#[derive(Serialize)]
struct VersionResponse {
    version: &'static str,
}

/// Reject non-finite coordinates — NaN/inf silently poison every downstream boolean op.
fn all_finite(points: &[[f64; 2]]) -> bool {
    points.iter().all(|p| p[0].is_finite() && p[1].is_finite())
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn rings_response(rings: Vec<Vec<[f64; 2]>>) -> String {
    serde_json::to_string(&RingsResponse { rings }).unwrap_or_else(|_| "{\"error\":\"serialize failed\"}".to_string())
}

fn error_response(message: impl Into<String>) -> String {
    serde_json::to_string(&ErrorResponse { error: message.into() })
        .unwrap_or_else(|_| "{\"error\":\"unknown\"}".to_string())
}

/// Handle one request (JSON bytes in, JSON string out). Exposed for the ABI (`process`) and for
/// tests that want to exercise the JSON contract without going through raw memory.
pub fn handle_request_json(bytes: &[u8]) -> String {
    let req: Request = match serde_json::from_slice(bytes) {
        Ok(r) => r,
        Err(e) => return error_response(format!("invalid request: {e}")),
    };

    match req {
        Request::Outline { kind, points, radii, size } => match kind.as_str() {
            "polyline" => {
                let radii = match radii {
                    Some(r) => r,
                    None => return error_response("outline: polyline requires \"radii\""),
                };
                // t147: malformed input used to fall through to an EMPTY ring list, which reads
                // downstream as "this stroke has no geometry" — so a caller bug made a stroke
                // silently VANISH. Reject loudly instead; empty rings now mean only that the
                // geometry genuinely collapsed.
                if points.is_empty() {
                    return error_response("outline: polyline requires at least one point");
                }
                if points.len() != radii.len() {
                    return error_response(format!(
                        "outline: polyline needs one radius per point — got {} radii for {} points",
                        radii.len(), points.len()));
                }
                if !all_finite(&points) {
                    return error_response("outline: polyline points must all be finite");
                }
                if !radii.iter().all(|r| r.is_finite() && *r > 0.0) {
                    return error_response("outline: polyline radii must all be finite and > 0");
                }
                rings_response(outline_polyline(&points, &radii))
            }
            "brush" => {
                let size = match size {
                    Some(s) => s,
                    None => return error_response("outline: brush requires \"size\""),
                };
                if points.is_empty() {
                    return error_response("outline: brush requires at least one point");
                }
                if !all_finite(&points) {
                    return error_response("outline: brush points must all be finite");
                }
                if !(size.is_finite() && size > 0.0) {
                    return error_response(format!(
                        "outline: brush size must be finite and > 0, got {size}"));
                }
                rings_response(outline_brush(&points, size))
            }
            other => error_response(format!("outline: unknown kind \"{other}\"")),
        },
        Request::Fuse { polygons } => {
            if polygons.iter().any(|p| !all_finite(p)) {
                return error_response("fuse: polygon points must all be finite");
            }
            rings_response(fuse_polygons(&polygons))
        }
        // Deliberately the crate version, not a git hash: the engine cannot know its own commit,
        // and a wrong claim is worse than a coarse one. Callers hash the ARTIFACT for exactness.
        Request::Version => serde_json::to_string(&VersionResponse {
            version: env!("CARGO_PKG_VERSION"),
        }).unwrap_or_else(|_| error_response("version: serialize failed")),
    }
}

// ---------------------------------------------------------------------------------------------
// WASM ABI: alloc / dealloc / process over raw linear memory.
// ---------------------------------------------------------------------------------------------

/// Allocate a `len`-byte buffer in linear memory and return a pointer to it. The caller writes
/// its request bytes into `[ptr, ptr+len)` before calling `process`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free a `len`-byte buffer previously returned by `alloc` (or by `process`'s response).
///
/// # Safety
/// `ptr` must have been returned by `alloc` (or `process`), with the same `len` it was allocated
/// (or the full length of the response buffer, including the 4-byte length prefix) with; it must
/// not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Process one request. `req_ptr`/`req_len` point at a request JSON buffer previously written
/// into a buffer from `alloc`. Returns a pointer to a response buffer: a 4-byte little-endian
/// length prefix followed by that many bytes of UTF-8 JSON (`{"rings": ...}` or `{"error": ...}`).
/// The caller must `dealloc(resp_ptr, 4 + prefix_length)` when done with the response.
///
/// # Safety
/// `req_ptr` must be valid for reads of `req_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn process(req_ptr: *mut u8, req_len: usize) -> *mut u8 {
    let req_bytes = std::slice::from_raw_parts(req_ptr, req_len);
    let resp_json = handle_request_json(req_bytes);
    let resp_bytes = resp_json.into_bytes();

    let mut out: Vec<u8> = Vec::with_capacity(4 + resp_bytes.len());
    out.extend_from_slice(&(resp_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&resp_bytes);

    let ptr = out.as_mut_ptr();
    std::mem::forget(out);
    ptr
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn polygon_area(ring: &[[f64; 2]]) -> f64 {
        let n = ring.len();
        let mut sum = 0.0;
        for i in 0..n {
            let (x0, y0) = (ring[i][0], ring[i][1]);
            let (x1, y1) = (ring[(i + 1) % n][0], ring[(i + 1) % n][1]);
            sum += x0 * y1 - x1 * y0;
        }
        (sum / 2.0).abs()
    }

    fn bbox(ring: &[[f64; 2]]) -> (f64, f64, f64, f64) {
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in ring {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
            min_y = min_y.min(p[1]);
            max_y = max_y.max(p[1]);
        }
        (min_x, min_y, max_x, max_y)
    }

    // Ray-casting point-in-polygon (even-odd), good enough for a test helper.
    fn contains_point(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
        let n = ring.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = (ring[i][0], ring[i][1]);
            let (xj, yj) = (ring[j][0], ring[j][1]);
            let intersects = ((yi > p[1]) != (yj > p[1]))
                && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi);
            if intersects {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    // --- fuse ---------------------------------------------------------------------------------

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn fuse_overlapping_squares_merges_into_one_ring() {
        let a = square(0.0, 0.0, 10.0, 10.0);
        let b = square(5.0, 5.0, 15.0, 15.0);
        let rings = fuse_polygons(&[a, b]);
        assert_eq!(rings.len(), 1, "overlapping squares should fuse into a single ring");

        let area = polygon_area(&rings[0]);
        let area_a = 100.0;
        let area_b = 100.0;
        let area_overlap = 25.0; // [5,10]x[5,10]
        let union_area = area_a + area_b - area_overlap;
        assert!(area < area_a + area_b, "union area must be strictly less than sum of areas");
        assert!((area - union_area).abs() < 1.0, "union area {area} should be close to {union_area}");
    }

    #[test]
    fn fuse_bowtie_self_intersection_repairs_to_valid_positive_area() {
        // A classic self-intersecting "bowtie" quad.
        let bowtie = vec![[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]];
        let rings = fuse_polygons(&[bowtie]);
        assert!(!rings.is_empty(), "bowtie should repair into at least one valid ring");
        for ring in &rings {
            assert!(ring.len() >= 3);
            let area = polygon_area(ring);
            assert!(area > 0.0, "repaired bowtie ring must have positive area");
        }
    }

    #[test]
    fn fuse_drops_interior_hole() {
        // Outer 10x10 square containing a 2x2 hole in the middle, expressed as two contours
        // whose union (per fill rule) creates a hole — fuse must drop it and return a solid
        // ring whose area equals the outer square's area.
        let outer = square(0.0, 0.0, 10.0, 10.0);
        // Ring frame: an annulus made from outer minus inner via two separate contours won't
        // create a hole through a plain union of two solid shapes (union never introduces
        // holes on its own) — so we directly construct a shape with a hole by donut-shaped
        // input: an outer boundary plus an inner boundary wound the *same* direction, which
        // under NonZero produces a filled donut only if directions differ. To reliably produce
        // a hole via `fuse`'s subject-union semantics, we instead verify hole-drop by union of
        // a "frame" (four thin rectangles forming a square ring) — the frame's union naturally
        // encloses a hole in its center, which fuse must fill in.
        let outer_area = 100.0;
        let frame = vec![
            square(0.0, 0.0, 10.0, 2.0),  // bottom
            square(0.0, 8.0, 10.0, 10.0), // top
            square(0.0, 2.0, 2.0, 8.0),   // left
            square(8.0, 2.0, 10.0, 8.0),  // right
        ];
        let rings = fuse_polygons(&frame);
        assert_eq!(rings.len(), 1, "frame should fuse into a single solid ring (hole dropped)");
        let area = polygon_area(&rings[0]);
        assert!((area - outer_area).abs() < 1.0, "hole-dropped area {area} should equal outer area {outer_area}");
        let _ = outer;
    }

    #[test]
    fn fuse_disjoint_squares_produces_two_rings() {
        let a = square(0.0, 0.0, 5.0, 5.0);
        let b = square(20.0, 20.0, 25.0, 25.0);
        let rings = fuse_polygons(&[a, b]);
        assert_eq!(rings.len(), 2, "disjoint squares should produce two separate rings");
    }

    // --- outline: polyline ---------------------------------------------------------------------

    #[test]
    fn outline_polyline_capsule_shape_and_area() {
        let w = 3.0;
        let p0 = [0.0, 0.0];
        let p1 = [20.0, 0.0];
        let rings = outline_polyline(&[p0, p1], &[w, w]);
        assert_eq!(rings.len(), 1);
        let ring = &rings[0];
        assert!(!ring.is_empty());

        let (min_x, min_y, max_x, max_y) = bbox(ring);
        // Segment inflated by w on every side: bbox ~ [-w, len+w] x [-w, w].
        let len = 20.0;
        assert!((min_x - (-w)).abs() < 0.5, "min_x {min_x}");
        assert!((max_x - (len + w)).abs() < 0.5, "max_x {max_x}");
        assert!((min_y - (-w)).abs() < 0.5, "min_y {min_y}");
        assert!((max_y - w).abs() < 0.5, "max_y {max_y}");

        let area = polygon_area(ring);
        let expected = 2.0 * w * len + std::f64::consts::PI * w * w;
        let rel_err = (area - expected).abs() / expected;
        assert!(rel_err < 0.02, "capsule area {area} should be close to {expected} (rel err {rel_err})");
    }

    #[test]
    fn outline_polyline_per_vertex_radius_is_wider_at_fatter_end() {
        let p0 = [0.0, 0.0];
        let p1 = [50.0, 0.0];
        let rings = outline_polyline(&[p0, p1], &[1.0, 8.0]);
        assert_eq!(rings.len(), 1);
        let ring = &rings[0];

        // Sample cross-section width near each end by measuring y-extent of points close to
        // each end's x coordinate.
        let width_near = |target_x: f64| -> f64 {
            let mut min_y = f64::INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for p in ring {
                if (p[0] - target_x).abs() < 2.0 {
                    min_y = min_y.min(p[1]);
                    max_y = max_y.max(p[1]);
                }
            }
            max_y - min_y
        };

        let width_thin_end = width_near(0.0);
        let width_fat_end = width_near(50.0);
        assert!(
            width_fat_end > width_thin_end,
            "fat end width {width_fat_end} should exceed thin end width {width_thin_end}"
        );
    }

    // --- outline: brush -------------------------------------------------------------------------

    #[test]
    fn outline_brush_produces_nonempty_polygon_containing_input_points() {
        let points = vec![[0.0, 0.0], [5.0, 2.0], [10.0, 0.0], [15.0, 3.0], [20.0, 0.0]];
        let rings = outline_brush(&points, 4.0);
        assert_eq!(rings.len(), 1);
        let ring = &rings[0];
        assert!(ring.len() >= 3);

        for p in &points {
            assert!(contains_point(ring, *p), "brush outline should contain input point {p:?}");
        }
    }

    // --- ABI round-trip --------------------------------------------------------------------------

    #[test]
    fn abi_round_trip_fuse() {
        let req = serde_json::json!({
            "op": "fuse",
            "polygons": [
                [[0.0,0.0],[10.0,0.0],[10.0,10.0],[0.0,10.0]],
                [[5.0,5.0],[15.0,5.0],[15.0,15.0],[5.0,15.0]],
            ]
        });
        let req_bytes = serde_json::to_vec(&req).unwrap();

        unsafe {
            let req_ptr = alloc(req_bytes.len());
            std::ptr::copy_nonoverlapping(req_bytes.as_ptr(), req_ptr, req_bytes.len());

            let resp_ptr = process(req_ptr, req_bytes.len());

            let len_bytes = std::slice::from_raw_parts(resp_ptr, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
            let json_bytes = std::slice::from_raw_parts(resp_ptr.add(4), len);
            let json_str = std::str::from_utf8(json_bytes).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();

            let rings = parsed.get("rings").expect("expected rings in response").as_array().unwrap();
            assert_eq!(rings.len(), 1, "overlapping squares should fuse to one ring via the ABI");

            dealloc(req_ptr, req_bytes.len());
            dealloc(resp_ptr, 4 + len);
        }
    }

    #[test]
    fn abi_round_trip_outline() {
        let req = serde_json::json!({
            "op": "outline",
            "kind": "polyline",
            "points": [[0.0,0.0],[20.0,0.0]],
            "radii": [3.0, 3.0]
        });
        let req_bytes = serde_json::to_vec(&req).unwrap();

        unsafe {
            let req_ptr = alloc(req_bytes.len());
            std::ptr::copy_nonoverlapping(req_bytes.as_ptr(), req_ptr, req_bytes.len());

            let resp_ptr = process(req_ptr, req_bytes.len());

            let len_bytes = std::slice::from_raw_parts(resp_ptr, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
            let json_bytes = std::slice::from_raw_parts(resp_ptr.add(4), len);
            let json_str = std::str::from_utf8(json_bytes).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();

            let rings = parsed.get("rings").expect("expected rings in response").as_array().unwrap();
            assert_eq!(rings.len(), 1);
            let ring = rings[0].as_array().unwrap();
            assert!(ring.len() >= 3);

            dealloc(req_ptr, req_bytes.len());
            dealloc(resp_ptr, 4 + len);
        }
    }

    #[test]
    fn abi_error_response_for_bad_op() {
        let req_bytes = b"{\"op\":\"bogus\"}".to_vec();
        unsafe {
            let req_ptr = alloc(req_bytes.len());
            std::ptr::copy_nonoverlapping(req_bytes.as_ptr(), req_ptr, req_bytes.len());
            let resp_ptr = process(req_ptr, req_bytes.len());

            let len_bytes = std::slice::from_raw_parts(resp_ptr, 4);
            let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
            let json_bytes = std::slice::from_raw_parts(resp_ptr.add(4), len);
            let json_str = std::str::from_utf8(json_bytes).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert!(parsed.get("error").is_some());

            dealloc(req_ptr, req_bytes.len());
            dealloc(resp_ptr, 4 + len);
        }
    }
}
