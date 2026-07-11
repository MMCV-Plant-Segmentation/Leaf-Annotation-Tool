/**
 * Straight-segment buffer outline for the polyline click-brush (a11y #40).
 *
 * A polyline is a brush driven by clicks; like the brush, the FE computes the EXACT stroke
 * polygon and both renders it and sends it, so the live preview and the STORED geometry are
 * identical (no FE-draws-vs-BE-stores drift). Unlike the brush (perfect-freehand, which bends
 * between points), a polyline is STRAIGHT between vertices with ROUND joins + caps at the
 * radius — i.e. exactly what the backend's `LineString.buffer(r, round)` produces, computed
 * here instead. The backend runs `ShapelyPolygon(outline).buffer(0)`, so a self-intersecting
 * ring (reflex joins, or a closed loop the user drew) is cleaned + filled server-side; the
 * live preview renders it with a non-zero fill rule so overlaps still fill.
 */

const ARC_STEP = Math.PI / 8;   // ≤ ~22.5° per arc segment — smooth enough joins/caps

function circle(cx: number, cy: number, r: number, steps = 24): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < steps; s++) {
    const a = (2 * Math.PI * s) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Left unit normal of the directed segment a→b (perpendicular, length 1). */
function leftNormal(a: number[], b: number[]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Constant-radius outline polygon (number[][]) of a polyline through `points`, straight
 * between vertices with round joins/caps. `size` is the stroke DIAMETER (radius = size/2),
 * matching how brush `strokeWidth` is used. Returns [] for an empty path.
 */
export function polylineOutline(points: number[][], size: number): number[][] {
  const r = Math.max(size, 1) / 2;
  // Drop degenerate + consecutive-duplicate points (zero-length segments have no normal).
  const P: number[][] = [];
  for (const p of points) {
    if (!p || p.length < 2) continue;
    const last = P[P.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) P.push([p[0], p[1]]);
  }
  if (P.length === 0) return [];
  if (P.length === 1) return circle(P[0][0], P[0][1], r);

  const out: number[][] = [];
  // Sweep the SHORT arc between two rim points around a centre (round join).
  const joinArc = (cx: number, cy: number, from: number[], to: number[]) => {
    const a0 = Math.atan2(from[1] - cy, from[0] - cx);
    const d = normAngle(Math.atan2(to[1] - cy, to[0] - cx) - a0);
    const steps = Math.max(1, Math.ceil(Math.abs(d) / ARC_STEP));
    for (let s = 1; s <= steps; s++) {
      const a = a0 + (d * s) / steps;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  // Semicircular cap around `c`, sweeping from the `from` rim point through the OUTWARD
  // direction to the opposite rim (forces the bulge to the correct side, unlike the short arc).
  const cap = (c: number[], from: number[], outward: [number, number]) => {
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    const sign = normAngle(Math.atan2(outward[1], outward[0]) - a0) >= 0 ? 1 : -1;
    const steps = Math.max(2, Math.ceil(Math.PI / ARC_STEP));
    for (let s = 1; s <= steps; s++) {
      const a = a0 + sign * Math.PI * (s / steps);
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  };

  // ── forward along the LEFT side ──
  for (let i = 0; i < P.length - 1; i++) {
    const [nx, ny] = leftNormal(P[i], P[i + 1]);
    out.push([P[i][0] + nx * r, P[i][1] + ny * r]);
    out.push([P[i + 1][0] + nx * r, P[i + 1][1] + ny * r]);
    if (i + 1 < P.length - 1) {
      const [mx, my] = leftNormal(P[i + 1], P[i + 2]);
      joinArc(P[i + 1][0], P[i + 1][1],
        [P[i + 1][0] + nx * r, P[i + 1][1] + ny * r],
        [P[i + 1][0] + mx * r, P[i + 1][1] + my * r]);
    }
  }
  // ── end cap ──
  const end = P[P.length - 1], eb = P[P.length - 2];
  const [enx, eny] = leftNormal(eb, end);
  const eDir: [number, number] = [end[0] - eb[0], end[1] - eb[1]];
  cap(end, [end[0] + enx * r, end[1] + eny * r], eDir);
  // ── back along the RIGHT side ──
  for (let i = P.length - 2; i >= 0; i--) {
    const [nx, ny] = leftNormal(P[i], P[i + 1]);
    out.push([P[i + 1][0] - nx * r, P[i + 1][1] - ny * r]);
    out.push([P[i][0] - nx * r, P[i][1] - ny * r]);
    if (i > 0) {
      const [mx, my] = leftNormal(P[i - 1], P[i]);
      joinArc(P[i][0], P[i][1],
        [P[i][0] - nx * r, P[i][1] - ny * r],
        [P[i][0] - mx * r, P[i][1] - my * r]);
    }
  }
  // ── start cap ──
  const start = P[0], sb = P[1];
  const [snx, sny] = leftNormal(start, sb);
  const sDir: [number, number] = [start[0] - sb[0], start[1] - sb[1]];
  cap(start, [start[0] - snx * r, start[1] - sny * r], sDir);
  return out;
}
