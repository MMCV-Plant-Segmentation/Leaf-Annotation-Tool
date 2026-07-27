/**
 * t104/D2 — FE↔BE stroke-geometry PARITY.
 *
 * Since D1 the server has derived every stroke's geometry from the geo-engine wasm, while the
 * browser drew its own outline with perfect-freehand. So the shape you saw while drawing and
 * the shape that got stored came from two different implementations, and could disagree.
 *
 * This locks the fix: the JS binding, given the same input, must reproduce the BACKEND
 * engine's output EXACTLY — not within a tolerance. Both sides execute the same committed
 * wasm bytes, and the module is deterministic, so anything short of exact equality means the
 * binding is marshalling wrong (endianness, memory growth detaching a view, a dropped ring).
 *
 * The fixture is generated FROM webapp/geo_engine.py (see the t104 commit), which is what
 * makes this a cross-language parity assertion rather than a self-consistency check. A
 * companion backend test (test_geo_engine_parity.py) pins the same fixture server-side, so
 * neither side can drift from it silently.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WASM = resolve(REPO, 'geo-engine/geo_engine.wasm');
const FIXTURE = resolve(REPO, 'webapp/tests/fixtures/geo_engine_parity.json');

type Case = { pts: number[][]; size?: number; radii?: number[]; rings: number[][][] };
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  brush: Record<string, Case>;
  polyline: Record<string, Case>;
  fuse: Record<string, { polygons: number[][][]; rings: number[][][] }>;
  version: string;
};
const fixtureVersion = fixture.version;

async function engine() {
  const mod = await import('../../src/projects/geoEngine');
  mod.resetGeoEngine();
  const bytes = readFileSync(WASM);
  mod.setGeoEngine(await mod.instantiateGeoEngine(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  return mod;
}

test.describe('geo-engine JS binding reproduces the backend engine EXACTLY', () => {
  test('brush outlines match the backend ring-for-ring, point-for-point', async () => {
    const mod = await engine();
    for (const [name, c] of Object.entries(fixture.brush)) {
      const got = await mod.outlineBrush(c.pts, c.size!);
      expect(got, `brush ${name}: ring count`).toHaveLength(c.rings.length);
      expect(got, `brush ${name}: geometry drifted from the backend engine`).toEqual(c.rings);
    }
  });

  test('polyline outlines match, including per-vertex radii', async () => {
    const mod = await engine();
    for (const [name, c] of Object.entries(fixture.polyline)) {
      const got = await mod.outlinePolyline(c.pts, c.radii!);
      expect(got, `polyline ${name}: ring count`).toHaveLength(c.rings.length);
      expect(got, `polyline ${name}: geometry drifted from the backend engine`).toEqual(c.rings);
    }
  });

  test('fuse unions polygons identically — the real-time fusion the FE could not do', async () => {
    const mod = await engine();
    for (const [name, c] of Object.entries(fixture.fuse)) {
      const got = await mod.fuse(c.polygons);
      expect(got, `fuse ${name}`).toEqual(c.rings);
      expect(got, `fuse ${name}: overlapping shapes must union to ONE ring`).toHaveLength(1);
    }
  });
});

test.describe('binding robustness', () => {
  test('a stroke long enough to grow wasm memory still returns intact geometry', async () => {
    // Regression guard for the subtle one: `process` can grow the module's memory, which
    // DETACHES any ArrayBuffer view taken beforehand. Reading the response through a stale
    // view yields garbage or throws. A long stroke is how you provoke the growth.
    const mod = await engine();
    const long = Array.from({ length: 4000 }, (_, i) => [i * 0.5, 50 + 20 * Math.sin(i / 20)]);
    const got = await mod.outlineBrush(long, 9);
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].length).toBeGreaterThan(3);
    for (const [x, y] of got[0]) {
      expect(Number.isFinite(x) && Number.isFinite(y), 'ring must be finite numbers').toBe(true);
    }
  });

  test('repeated calls on one instance stay identical (no leaked state between calls)', async () => {
    const mod = await engine();
    const c = Object.values(fixture.brush)[0];
    const first = await mod.outlineBrush(c.pts, c.size!);
    for (let i = 0; i < 5; i++) {
      expect(await mod.outlineBrush(c.pts, c.size!)).toEqual(first);
    }
  });

  test('t147: malformed input errors instead of silently yielding a vanished stroke', async () => {
    // These all used to return [] — and [] reads downstream as "this stroke has no geometry",
    // so a caller bug made the stroke silently disappear. The ENGINE now rejects them (t147),
    // and the binding surfaces that as a thrown Error rather than an empty result. Validation
    // lives in the engine ONLY: duplicating it here is how the two drift apart.
    const mod = await engine();
    await expect(mod.outlinePolyline([[0, 0], [1, 1]], [1]),
      'radii shorter than points').rejects.toThrow(/one radius per point/);
    await expect(mod.outlinePolyline([[0, 0], [1, 1]], [1, 2, 3]),
      'radii longer than points').rejects.toThrow(/one radius per point/);
    await expect(mod.outlinePolyline([[0, 0], [1, 1]], [1, 0]),
      'a zero radius').rejects.toThrow(/finite and > 0/);
    await expect(mod.outlineBrush([], 5), 'no points').rejects.toThrow(/at least one point/);
    await expect(mod.outlineBrush([[0, 0], [10, 10]], -5),
      'a negative size').rejects.toThrow(/must be finite and > 0/);
  });

  test('legitimate degenerate-ish input is still accepted', async () => {
    // A one-point brush dab, a ONE-POINT POLYLINE (renders as a disk — an earlier version of
    // this binding wrongly rejected it), and a hairline stroke are all real things to draw.
    const mod = await engine();
    await expect(mod.outlineBrush([[5, 5]], 4)).resolves.toBeDefined();
    expect(await mod.outlinePolyline([[5, 5]], [3]), 'one-point polyline').toHaveLength(1);
    await expect(mod.outlinePolyline([[0, 0], [1, 1]], [0.5, 0.5])).resolves.toBeDefined();
  });

  test('the engine identifies itself, and both bindings report the same version', async () => {
    // Christian's runtime drift check: a build step only catches drift at BUILD time, so the
    // engine says which one it is. Pinned against the backend's answer in the same fixture.
    const mod = await engine();
    const v = await mod.version();
    expect(v, 'version must be a non-empty string').toMatch(/^\d+\.\d+\.\d+$/);
    expect(v, 'FE and BE must report the SAME engine version').toBe(fixtureVersion);
  });
});
