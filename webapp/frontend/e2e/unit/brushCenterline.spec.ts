/**
 * t158 — the live brush preview paints the engine's CENTRELINE as a round-capped stroke instead
 * of recomputing the outline every pointer move. That is only honest if the stored outline IS a
 * round brush of the same width along that centreline. This pins it, on the committed wasm:
 *
 *  BC1  the centreline starts/ends exactly at the stroke's first/last point.
 *  BC2  every vertex of the stored brush outline lies size/2 from the centreline (the round-brush
 *       stroke the preview paints), for the parity fixture's strokes — so preview == stored.
 *  BC3  not-yet-loaded engine → empty centreline (cosmetic, self-healing), never a throw.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WASM = resolve(REPO, 'geo-engine/geo_engine.wasm');
const FIXTURE = JSON.parse(readFileSync(resolve(REPO, 'webapp/tests/fixtures/geo_engine_parity.json'), 'utf8')) as
  { brush: Record<string, { pts: number[][]; size: number }> };

async function engine() {
  const mod = await import('../../src/projects/geoEngine');
  mod.resetGeoEngine();
  const bytes = readFileSync(WASM);
  mod.setGeoEngine(await mod.instantiateGeoEngine(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  return mod;
}

function distToPolyline(p: number[], line: number[][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

test('BC1 — centreline runs from the first to the last point', async () => {
  const mod = await engine();
  const pts = [[0, 0], [20, 5], [40, 0], [60, 10]];
  const line = mod.brushCenterlineSyncOrEmpty(pts, 10);
  expect(line.length).toBeGreaterThan(pts.length);
  expect(line[0]).toEqual([0, 0]);
  expect(line[line.length - 1]).toEqual([60, 10]);
});

test('BC2 — the stored outline is the round-brush stroke of the centreline', async () => {
  const mod = await engine();
  for (const [name, c] of Object.entries(FIXTURE.brush)) {
    const line = mod.brushCenterlineSyncOrEmpty(c.pts, c.size);
    const [ring] = await mod.outlineBrush(c.pts, c.size);
    for (const v of ring) {
      // 32-gon caps/joins + the engine's 1/1024 grid: within 0.05·r of the exact round brush.
      expect(Math.abs(distToPolyline(v, line) - c.size / 2), `${name} vertex ${v}`)
        .toBeLessThan(0.05 * c.size / 2 + 0.01);
    }
  }
});

test('BC3 — engine not loaded yet → empty centreline, no throw', async () => {
  const mod = await import('../../src/projects/geoEngine');
  mod.resetGeoEngine();
  expect(mod.brushCenterlineSyncOrEmpty([[0, 0], [5, 5]], 4)).toEqual([]);
});
