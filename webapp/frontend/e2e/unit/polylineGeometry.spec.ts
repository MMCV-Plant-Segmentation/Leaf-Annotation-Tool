/**
 * polylineOutlineRings — the polyline click-brush's outline, now produced by the SHARED ENGINE.
 *
 * The behaviour asserted here is unchanged and still required: straight segments, round
 * joins/caps at each vertex's own radius, and t62's per-vertex tapering. What changed in t150 is
 * only WHERE the geometry comes from — the engine the server also uses, instead of a second
 * FE-side implementation that could disagree with it.
 */
import { test, expect } from '@playwright/test';

// t150: these exercise geometry that now comes from the shared wasm engine rather than a pure-JS
// implementation, so the engine must be loaded first. Same artifact the server runs.
async function loadEngine() {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const mod = await import('../../src/projects/geoEngine');
  const b = readFileSync(resolve(repo, 'geo-engine/geo_engine.wasm'));
  mod.setGeoEngine(await mod.instantiateGeoEngine(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

function inside(poly: number[][], x: number, y: number): boolean {
  // even-odd ray cast (valid for the simple, non-self-intersecting rings tested here)
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** The outline's single exterior ring — these fixtures are all simple connected shapes. */
function ring(rings: number[][][]): number[][] {
  expect(rings.length, 'expected exactly one exterior ring').toBe(1);
  return rings[0];
}
function bbox(poly: number[][]) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test.describe('polylineOutlineRings', () => {
  test('a single point buffers to a disc around it (all rim points ~r away)', async () => {
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = ring(polylineOutlineRings([[50, 50]], 20));   // r = 10
    expect(poly.length).toBeGreaterThan(6);
    for (const [x, y] of poly) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(10, 1);
    expect(inside(poly, 50, 50)).toBe(true);
  });

  test('a horizontal segment buffers to a capsule spanning ±r past the ends', async () => {
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = ring(polylineOutlineRings([[0, 0], [100, 0]], 20));   // r = 10
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
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = ring(polylineOutlineRings([[0, 0], [100, 0], [100, 100]], 16));   // r = 8
    for (const [x, y] of [[0, 0], [100, 0], [100, 100], [50, 0], [100, 50]])
      expect(inside(poly, x, y)).toBe(true);
    expect(inside(poly, 0, 100)).toBe(false);
    expect(inside(poly, 200, 200)).toBe(false);
  });

  test('an empty path yields an empty outline', async () => {
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    expect(polylineOutlineRings([], 20)).toEqual([]);
  });

  test('t62: per-point sizes make a VARIABLE-width outline (radius from each vertex)', async () => {
    // Christian (2026-07-19): a polyline vertex carries its own size ([x,y,size]); the outline
    // tapers between vertices so the width tweens along the path. The trailing `size` param is a
    // fallback for legacy 2-tuple points only — a 3-tuple's own size wins.
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    // size 20 (r≈10) at the start → size 60 (r≈30) at the end. Fallback size 20 must NOT override.
    const poly = ring(polylineOutlineRings([[0, 0, 20], [100, 0, 60]], 20));
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
    await loadEngine();
    const { polylineOutlineRings } = await import('../../src/projects/canvasPolylineGeometry');
    const poly = ring(polylineOutlineRings([[0, 0], [100, 0]], 20));   // no per-point size → r=10 everywhere
    expect(inside(poly, 50, 8)).toBe(true);
    expect(inside(poly, 50, 20)).toBe(false);
  });
});
