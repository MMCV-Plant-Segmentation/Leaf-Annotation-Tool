/**
 * t158 — the live brush preview is INCREMENTAL: each pointer move only hands the engine the new
 * points, and only a short tail behind the pen may change. On the committed wasm:
 *
 *  BS1  fed one point at a time, the preview's final line == the stored centreline (preview ==
 *       stored), for every parity-fixture stroke.
 *  BS2  locality: what was final stays final — every earlier frame's closed chunks are the same
 *       objects, unchanged, and the frozen part only grows.
 *  BS3  a draft that is not an extension (new stroke, size change) restarts cleanly.
 *  BS4  engine not loaded yet → empty line, never a throw.
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

/** The full line a frame shows: closed chunks (each repeats the previous chunk's last point)
 * then the live path. */
function flatten(l: { chunks: number[][][]; live: number[][] }): number[][] {
  const out: number[][] = [];
  for (const c of [...l.chunks, l.live]) out.push(...(out.length ? c.slice(1) : c));
  return out;
}

test('BS1 — incremental preview ends on exactly the stored centreline', async () => {
  const geo = await engine();
  const { createBrushStream } = await import('../../src/projects/brushStream');
  for (const [name, c] of Object.entries(FIXTURE.brush)) {
    const s = createBrushStream();
    let line = s.update([], c.size);
    const draft: number[][] = [];
    for (const p of c.pts) { draft.push(p); line = s.update([...draft], c.size); }
    s.end();
    expect(flatten(line), name).toEqual(geo.brushCenterlineSyncOrEmpty(c.pts, c.size));
  }
});

test('BS2 — closed chunks never change and the frozen part only grows', async () => {
  await engine();
  const { createBrushStream, BRUSH_CHUNK_POINTS } = await import('../../src/projects/brushStream');
  // A long slow wobbly stroke, so several chunks close.
  const pts = Array.from({ length: 1500 }, (_, i) => [i * 1.5, 0.8 * Math.sin((2 * Math.PI * i * 1.5) / 12)]);
  const s = createBrushStream();
  let draft: number[][] = [];
  let seen: { ref: number[][]; copy: number[][] }[] = [];
  for (const p of pts) {
    draft = [...draft, p];
    const l = s.update(draft, 16);
    for (const [i, old] of seen.entries()) {
      expect(l.chunks[i]).toBe(old.ref);
      expect(l.chunks[i]).toEqual(old.copy);
    }
    seen = l.chunks.map((ref) => ({ ref, copy: ref.map((q) => [...q]) }));
  }
  expect(seen.length).toBeGreaterThan(2);
  expect(seen.every((c) => c.ref.length === BRUSH_CHUNK_POINTS)).toBe(true);
  s.end();
});

test('BS3 — new stroke or size change restarts the stream', async () => {
  const geo = await engine();
  const { createBrushStream } = await import('../../src/projects/brushStream');
  const s = createBrushStream();
  const a = [[0, 0], [20, 5], [40, 0]], b = [[100, 100], [80, 120], [60, 100]];
  s.update(a, 10);
  expect(flatten(s.update(b.map((p) => [...p]), 10))).toEqual(geo.brushCenterlineSyncOrEmpty(b, 10));
  expect(flatten(s.update(b.map((p) => [...p]), 6))).toEqual(geo.brushCenterlineSyncOrEmpty(b, 6));
  s.end();
});

test('BS4 — engine not loaded yet → empty line, no throw', async () => {
  const mod = await import('../../src/projects/geoEngine');
  mod.resetGeoEngine();
  const { createBrushStream } = await import('../../src/projects/brushStream');
  const l = createBrushStream().update([[0, 0], [5, 5]], 4);
  expect(l.chunks).toEqual([]);
  expect(l.live).toEqual([]);
});
