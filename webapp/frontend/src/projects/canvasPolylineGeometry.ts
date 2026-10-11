/**
 * t150 — polyline INPUT preparation for the shared geo-engine.
 *
 * This module used to implement the polyline outline itself (tangent quads + round joins) — a
 * second implementation of geometry the server already owned, which is exactly how the live
 * preview and the stored mask could disagree. The geometry now comes from the engine. What
 * survives here is the part that is product semantics rather than maths:
 *
 *   - per-vertex sizing (t62): a point may be an [x, y, size] 3-tuple carrying its OWN size,
 *     which wins over the stroke's fallback size — that is what makes a stroke taper;
 *   - dropping consecutive duplicate points, which have no meaningful direction.
 *
 * The server reproduces the same per-vertex widths, so preview and stored mask agree.
 */
import { outlinePolylineSyncOrEmpty } from './geoEngine';

/** A vertex's radius: its own size if it carries one ([x, y, size]), else the stroke's, floored
 * at 1px diameter — matching how brush `strokeWidth` is used. */
function vertexRadius(p: number[], fallbackSize: number): number {
  const size = p.length > 2 && p[2] != null ? p[2] : fallbackSize;
  return Math.max(size, 1) / 2;
}

/** Drop degenerate + consecutive-duplicate points (a zero-length segment has no normal). */
function compact(points: number[][]): number[][] {
  const out: number[][] = [];
  for (const p of points) {
    if (!p || p.length < 2) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push(p);
  }
  return out;
}

/** The polyline's outline rings, via the engine. `size` is the fallback DIAMETER for any point
 * that does not carry its own. Returns [] for an empty path — or while the engine is still
 * loading, which only blanks the transient preview (the stroke still commits correctly). */
export function polylineOutlineRings(points: number[][], size: number): number[][][] {
  const P = compact(points);
  if (P.length === 0) return [];
  return outlinePolylineSyncOrEmpty(
    P.map((p) => [p[0], p[1]]),
    P.map((p) => vertexRadius(p, size)),
  );
}
