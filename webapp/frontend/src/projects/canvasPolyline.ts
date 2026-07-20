import type { Accessor, Setter } from 'solid-js';

/**
 * Polyline click-brush helpers — a11y feature #40, per-click persistence rebuild
 * (Christian, 2026-07-13). Each click behaves like a brush stroke on finger-lift:
 * persist + fuse immediately. The interaction fires `polylineStep` on every click
 * with the growing point list; the persistence layer resolves the 1st call as
 * `createAnnotation` and each subsequent call as `editStroke` — so the mask exists
 * after the FIRST click and grows one vertex per click.
 *
 * The draft signal holds the placed vertices only to drive the rubber-band overlay
 * (last vertex → cursor). ESC and tool-switch clear the draft; there is no ESC/Enter
 * commit path (nothing to commit — every click is already persisted), and there is no
 * snap-to-first-vertex auto-close (that was the OLD buffered model). Each click is its
 * own undo entry: the 1st is a `draw`/`merge` history entry (mutate delete on undo),
 * every subsequent click an `edit` (reverse-stroke-edit peels one vertex on undo).
 *
 * Kept in its own module so `canvasInteraction.ts` stays under the 200-line file cap.
 */
export interface PolylineClickOpts {
  draft: Accessor<number[][]>;
  setDraft: Setter<number[][]>;
  brushSize: Accessor<number>;
  /** Per-click persistence hook — called with the growing point list on every click.
   * The persistence layer decides create-vs-edit; the interaction just dispatches. */
  polylineStep: (points: number[][], strokeWidth: number) => void;
}

/**
 * Handle one polyline click at image coordinates (ix, iy). Append the vertex to the
 * draft (source of the rubber-band's first endpoint) and fire the per-click hook with
 * the full growing point list. No snap-close: a click landing near the first vertex is
 * treated exactly like any other click (the user ends the line with ESC / tool-switch).
 */
export function polylineClick(ix: number, iy: number, o: PolylineClickOpts): void {
  // t62 (Christian, 2026-07-19): each vertex carries its OWN size ([x, iy, size]) so the
  // stroke width tweens along the path — scroll-between-clicks changes the size applied to
  // the NEXT click only (matches the brush's finger-lift semantics per vertex).
  const next = [...o.draft(), [ix, iy, o.brushSize()]];
  o.setDraft(next);
  o.polylineStep(next, o.brushSize());
}
