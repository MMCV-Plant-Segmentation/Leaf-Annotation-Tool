// t139 — pure tile-navigation helpers + the composable that wires them into the canvas.
// The annotator canvas steps through a FLAT list of every tile across the batch's images
// (crossing image boundaries). Framing (padTileRect) happens ONLY on an explicit prev/next
// step — the initial open keeps the pre-t139 whole-image fit (CanvasScreen owns that).
import { createSignal, createMemo, batch, type Accessor, type Setter } from 'solid-js';
import type { ViewBox } from './canvasShapes';

/** Minimal shapes this module needs — kept structural so callers can pass the real
 * CanvasImage/CanvasTile (or plain test fixtures) without a dependency on canvasApi.ts. */
export type TileLike = { x: number; y: number; w: number; h: number };
export type ImageLike = { tiles: TileLike[] };

export type FlatTile<T extends TileLike = TileLike> = { imgIdx: number; tileIdx: number; tile: T };

/** Every tile across `images`, in order (image 0's tiles first, then image 1's, …), each
 * carrying its parent image index and its index within that image. */
export const flattenTiles = <I extends ImageLike>(images: I[]): FlatTile<I['tiles'][number]>[] =>
  images.flatMap((im, imgIdx) => im.tiles.map((tile, tileIdx) => ({ imgIdx, tileIdx, tile })));

/** `cur + dir`, clamped to [0, total-1] — no wrap, so prev/next disable at the ends. */
export const stepTileIndex = (total: number, cur: number, dir: 1 | -1): number =>
  Math.max(0, Math.min(total - 1, cur + dir));

/** The tile's viewBox expanded by `pad` fraction on every side, centered on the tile. */
export const padTileRect = (tile: TileLike, pad: number): ViewBox => ({
  x: tile.x - tile.w * pad,
  y: tile.y - tile.h * pad,
  w: tile.w * (1 + 2 * pad),
  h: tile.h * (1 + 2 * pad),
});

/** Wires the flat-tile list into the canvas: a `tileIndex` signal over `flattenTiles(images())`,
 * a prev/next step that moves `imgIdx` along when the landed tile lives on a DIFFERENT image
 * and frames the landed tile (padTileRect, 10% pad) into `setVb`. Framing is imperative —
 * driven only by an explicit step call — so the initial open (tileIndex defaults to 0, unused
 * until a step happens) is untouched by this composable; the caller's own on(imageId) effect
 * keeps its pre-t139 whole-image fit for the initial load.
 *
 * `isFraming()`/`consumeFraming()` let the caller's on(imageId) effect tell a tile-nav-driven
 * image switch (skip its fitImage — the tile frame above must win) apart from any OTHER
 * reason imgIdx changed (keep fitImage as-is). */
export function createTileNav<I extends ImageLike>(
  images: Accessor<I[] | undefined>, imgIdx: Accessor<number>, setImgIdx: Setter<number>, setVb: (vb: ViewBox) => void,
) {
  const [tileIndex, setTileIndex] = createSignal(0);
  const flatTiles = createMemo(() => flattenTiles(images() ?? []));
  let framing = false;
  const step = (dir: 1 | -1) => {
    const flat = flatTiles();
    const next = stepTileIndex(flat.length, tileIndex(), dir);
    const entry = flat[next];
    if (!entry) { setTileIndex(next); return; }
    batch(() => {
      setTileIndex(next);
      if (entry.imgIdx !== imgIdx()) { framing = true; setImgIdx(entry.imgIdx); }
      setVb(padTileRect(entry.tile, 0.10));
    });
  };
  const consumeFraming = () => { const f = framing; framing = false; return f; };
  return { tileIndex, flatTiles, tilePrev: () => step(-1), tileNext: () => step(1), consumeFraming };
}
