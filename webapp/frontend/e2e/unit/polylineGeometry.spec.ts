/**
 * polylineOutline — the straight-segment buffer polygon for the polyline click-brush.
 *
 * Same principle as the brush's perfect-freehand outline: the FE computes the exact stroke
 * polygon (constant-radius, STRAIGHT segments, ROUND joins/caps) so the live preview and the
 * STORED geometry are identical (parity with the brush; a11y #40). This is the shape the
 * backend's LineString.buffer produces, computed FE-side.
 */
import { test, expect } from '@playwright/test';

function inside(poly: number[][], x: number, y: number): boolean {
  // even-odd ray cast (valid for the simple, non-self-intersecting rings tested here)
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function bbox(poly: number[][]) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test.describe('polylineOutline', () => {
  test('a single point buffers to a disc around it (all rim points ~r away)', async () => {
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = polylineOutline([[50, 50]], 20);   // r = 10
    expect(poly.length).toBeGreaterThan(6);
    for (const [x, y] of poly) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(10, 1);
    expect(inside(poly, 50, 50)).toBe(true);
  });

  test('a horizontal segment buffers to a capsule spanning ±r past the ends', async () => {
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = polylineOutline([[0, 0], [100, 0]], 20);   // r = 10
    const b = bbox(poly);
    expect(b.minX).toBeCloseTo(-10, 0);   // round cap extends past the start
    expect(b.maxX).toBeCloseTo(110, 0);   // …and past the end
    expect(b.minY).toBeCloseTo(-10, 0);
    expect(b.maxY).toBeCloseTo(10, 0);
    // the centerline is inside the filled shape, a point well outside is not
    for (const [x, y] of [[0, 0], [50, 0], [100, 0]]) expect(inside(poly, x, y)).toBe(true);
    expect(inside(poly, 50, 40)).toBe(false);
  });

  test('an L-shaped polyline encloses every vertex (round join), excludes far points', async () => {
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = polylineOutline([[0, 0], [100, 0], [100, 100]], 16);   // r = 8
    for (const [x, y] of [[0, 0], [100, 0], [100, 100], [50, 0], [100, 50]])
      expect(inside(poly, x, y)).toBe(true);
    expect(inside(poly, 0, 100)).toBe(false);
    expect(inside(poly, 200, 200)).toBe(false);
  });

  test('an empty path yields an empty outline', async () => {
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    expect(polylineOutline([], 20)).toEqual([]);
  });

  test('t62: per-point sizes make a VARIABLE-width outline (radius from each vertex)', async () => {
    // Christian (2026-07-19): a polyline vertex carries its own size ([x,y,size]); the outline
    // tapers between vertices so the width tweens along the path. The trailing `size` param is a
    // fallback for legacy 2-tuple points only — a 3-tuple's own size wins.
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    // size 20 (r≈10) at the start → size 60 (r≈30) at the end. Fallback size 20 must NOT override.
    const poly = polylineOutline([[0, 0, 20], [100, 0, 60]], 20);
    // Near the START the half-width is ~10.
    expect(inside(poly, 0, 8)).toBe(true);
    expect(inside(poly, 0, 20)).toBe(false);
    // Near the END the half-width is ~30 — this is what a constant-radius (r=10) outline gets wrong.
    expect(inside(poly, 100, 25)).toBe(true);
    expect(inside(poly, 100, 40)).toBe(false);
    // The outline is wider at the big-size end than the small-size end.
    const yAt = (x: number) => Math.max(...poly.filter((p) => Math.abs(p[0] - x) < 2).map((p) => p[1]));
    expect(yAt(100)).toBeGreaterThan(yAt(0) + 8);
  });

  test('t62: a legacy 2-tuple point falls back to the size param (backward compatible)', async () => {
    const { polylineOutline } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = polylineOutline([[0, 0], [100, 0]], 20);   // no per-point size → r=10 everywhere
    expect(inside(poly, 50, 8)).toBe(true);
    expect(inside(poly, 50, 20)).toBe(false);
  });
});
