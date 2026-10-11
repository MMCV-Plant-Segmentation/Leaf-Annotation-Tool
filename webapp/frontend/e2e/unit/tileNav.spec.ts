/**
 * t139 — the annotator navigates by TILE, not by image.
 *
 * next/prev step a flat list of every tile across the batch's images (in order, crossing
 * image boundaries). Landing on a tile FRAMES it: the viewBox is the tile expanded by a
 * small pad on each side, and the canvas SVG's preserveAspectRatio=meet then letterboxes so
 * the padded tile fills whichever axis binds (centered on the other) — no distortion.
 *
 * Pure helpers, tested here browserless (the wiring in CanvasScreen/CanvasToolbar is covered
 * by the existing canvas specs). Helpers live in src/projects/canvasTileNav.ts.
 */
import { test, expect } from '@playwright/test';

const IMAGES = [
  { tiles: [{ x: 0, y: 0, w: 100, h: 100, tileId: 'a0' }, { x: 100, y: 0, w: 100, h: 100, tileId: 'a1' }] },
  { tiles: [{ x: 0, y: 0, w: 100, h: 100, tileId: 'b0' }] },
];

test.describe('flattenTiles', () => {
  test('flattens every tile across images, carrying the parent image index', async () => {
    const { flattenTiles } = await import('../../src/projects/canvasTileNav');
    const flat = flattenTiles(IMAGES);
    expect(flat.map((f) => f.tile.tileId)).toEqual(['a0', 'a1', 'b0']);
    expect(flat.map((f) => f.imgIdx)).toEqual([0, 0, 1]);   // the 3rd tile lives on the 2nd image
    expect(flat[2].tileIdx).toBe(0);                        // …as that image's first tile
  });

  test('is empty when no image has tiles', async () => {
    const { flattenTiles } = await import('../../src/projects/canvasTileNav');
    expect(flattenTiles([{ tiles: [] }])).toEqual([]);
  });
});

test.describe('stepTileIndex — clamped, no wrap (prev/next disable at the ends)', () => {
  test('advances and retreats within [0, total-1]', async () => {
    const { stepTileIndex } = await import('../../src/projects/canvasTileNav');
    expect(stepTileIndex(3, 0, +1)).toBe(1);
    expect(stepTileIndex(3, 1, +1)).toBe(2);
    expect(stepTileIndex(3, 2, +1)).toBe(2);   // clamped at the last tile
    expect(stepTileIndex(3, 0, -1)).toBe(0);   // clamped at the first tile
    expect(stepTileIndex(3, 2, -1)).toBe(1);
  });
});

test.describe('padTileRect — frame a tile with padding', () => {
  test('expands the tile by the pad fraction on every side, keeping it centered', async () => {
    const { padTileRect } = await import('../../src/projects/canvasTileNav');
    const vb = padTileRect({ x: 100, y: 200, w: 50, h: 60 }, 0.1);
    expect(vb).toEqual({ x: 95, y: 194, w: 60, h: 72 });   // x-5, y-6, w*1.2, h*1.2
    expect(vb.x + vb.w / 2).toBeCloseTo(125);              // tile center x preserved
    expect(vb.y + vb.h / 2).toBeCloseTo(230);              // tile center y preserved
  });

  test('a square tile yields a square-centered frame (meet letterboxes to fit)', async () => {
    const { padTileRect } = await import('../../src/projects/canvasTileNav');
    const vb = padTileRect({ x: 0, y: 0, w: 128, h: 128 }, 0.1);
    expect(vb.w).toBeCloseTo(128 * 1.2);
    expect(vb.h).toBeCloseTo(128 * 1.2);
    expect(vb.x).toBeCloseTo(-12.8);
    expect(vb.y).toBeCloseTo(-12.8);
  });
});
