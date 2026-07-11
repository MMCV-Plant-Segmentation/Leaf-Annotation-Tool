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
});
