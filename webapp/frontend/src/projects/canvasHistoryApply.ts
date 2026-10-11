/**
 * View-update helpers shared by canvasHistory.ts and canvasHistoryDispatch.ts. Extracted
 * so both modules can import these without a runtime cycle. Zero policy — pure functions
 * over an `UpdateImg` callback.
 */
import type { CanvasAnnotation, CanvasImage, TileStateUpdate } from './api';
import { mergeTileStates } from './canvasShapes';

export type UpdateImg = (fn: (im: CanvasImage) => CanvasImage) => void;

/** Splice add/remove annotations + patch tile-state updates into the current image. */
export function applyDelta(
  updateImg: UpdateImg,
  add: CanvasAnnotation[],
  removeIds: string[],
  tileStates: TileStateUpdate[] = [],
): void {
  updateImg((im) => ({
    ...im,
    annotations: [
      ...im.annotations.filter((a) => !removeIds.includes(a.id)),
      ...add,
    ],
    // BUGS #16: the server may have re-opened a completed tile this mutation touched.
    tiles: mergeTileStates(im.tiles, tileStates),
  }));
}

/** Re-render a lesion in place after a label-only PATCH (relabel undo/redo): same id,
 * fresh label/labelColor/labelSnapshot from the server response — no add/remove. */
export function applyRelabel(updateImg: UpdateImg, updated: CanvasAnnotation): void {
  updateImg((im) => ({
    ...im,
    annotations: im.annotations.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)),
  }));
}
