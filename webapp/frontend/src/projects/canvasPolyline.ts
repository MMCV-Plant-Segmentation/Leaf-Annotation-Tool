import type { Accessor, Setter } from 'solid-js';

/**
 * Polyline click-brush helpers — a11y feature #40. A polyline is a BRUSH driven by
 * CLICKS: each click drops a vertex (no drag, no auto-commit), a click within the
 * brush RADIUS of the start vertex snaps to it and commits a closed loop, and
 * `finishDraft()` commits any OPEN polyline (a lone vertex commits as a dot).
 *
 * The commit callback carries `tool='polyline'` in a trailing arg so downstream
 * persistence tags the stroke's provenance (see `canvasPersistence.ts`); brush
 * strokes leave that arg undefined and default to 'brush' server-side.
 *
 * Kept in its own module so `canvasInteraction.ts` stays under the 200-line file cap.
 */
export interface PolylineDraftOpts {
  draft: Accessor<number[][]>;
  setDraft: Setter<number[][]>;
  brushSize: Accessor<number>;
  commit: (kind: string, points: number[][], passNo?: number, strokeWidth?: number, tool?: string) => void;
}

/**
 * Handle one click at image coordinates (ix, iy). If the click lands within the
 * brush radius of the FIRST vertex, snap to it and commit the polyline as a
 * closed loop (the final point equals the start). Otherwise append (ix, iy) to
 * the draft.
 */
export function polylineClick(ix: number, iy: number, o: PolylineDraftOpts): void {
  const d = o.draft();
  const r = o.brushSize() / 2;
  if (d.length && Math.hypot(ix - d[0][0], iy - d[0][1]) <= r) {
    o.commit('stroke', [...d, [d[0][0], d[0][1]]], 1, o.brushSize(), 'polyline');
    o.setDraft([]);
  } else {
    o.setDraft((p) => [...p, [ix, iy]]);
  }
}

/**
 * Commit an OPEN polyline via ESC / tool-switch / Enter. A lone vertex commits as
 * a single-point stroke (a dot of the current radius, like a brush click); an empty
 * draft is a no-op.
 */
export function polylineFinish(o: PolylineDraftOpts): void {
  const d = o.draft();
  if (d.length) o.commit('stroke', d, 1, o.brushSize(), 'polyline');
  o.setDraft([]);
}
