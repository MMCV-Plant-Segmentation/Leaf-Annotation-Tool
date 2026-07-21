import type { Accessor, Setter } from 'solid-js';
import { resolveSnap, type VertexIndex } from './canvasSnap';

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
 * PHASE 2b (t50, 2026-07-20): a click within `snapRadiusImg` of an existing indexed
 * vertex snaps onto its CANONICAL position (keeping the click's own brush size) and
 * carries that vertex's stable id as a per-point ref, threaded to the persistence layer
 * as `vertexRefs` so the backend shares/locks the vertex. Otherwise the raw point is
 * placed with a null ref (mint), exactly as before.
 *
 * Kept in its own module so `canvasInteraction.ts` stays under the 200-line file cap.
 */
export interface PolylineClickOpts {
  draft: Accessor<number[][]>;
  setDraft: Setter<number[][]>;
  /** Parallel per-point vertex refs (null = mint, string = snapped-onto existing vertex). */
  draftRefs: Accessor<(string | null)[]>;
  setDraftRefs: (v: (string | null)[]) => void;
  brushSize: Accessor<number>;
  /** The current snap index (every existing vertex on the image) + the image-space
   * brush RADIUS for this click; resolveSnap combines it with each vertex's own radius
   * as max(brushRadius, vertexRadius) (t80). */
  snapIndex: Accessor<VertexIndex>;
  snapRadiusImg: Accessor<number>;
  /** Per-click persistence hook — called with the growing point list on every click.
   * The persistence layer decides create-vs-edit; the interaction just dispatches. */
  polylineStep: (points: number[][], strokeWidth: number, refs: (string | null)[]) => void;
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
  const size = o.brushSize();
  const hit = resolveSnap(o.snapIndex(), ix, iy, o.snapRadiusImg());
  const point = hit ? [hit.x, hit.y, size] : [ix, iy, size];
  const ref = hit ? hit.vertexId : null;

  const next = [...o.draft(), point];
  o.setDraft(next);
  const nextRefs = [...o.draftRefs(), ref];
  o.setDraftRefs(nextRefs);
  o.polylineStep(next, size, nextRefs);
}

const EMPTY_INDEX: VertexIndex = { index: null, xs: [], ys: [], ids: [], radii: [], maxRadius: 0 };

/** Thin adapter so `canvasInteraction.ts`'s pointer-down handler stays a one-line call
 * (the file is at the 200-line cap) — accepts the interaction's opts shape directly.
 * Snap-related fields are optional here (only CanvasScreen's polyline tool wires them;
 * MergeCanvasScreen has no polyline tool and never reaches this branch, but its opts
 * type is shared, so this defaults to a no-op/empty-index snap for type compatibility). */
export function firePolylineClick(ix: number, iy: number, o: {
  draft: Accessor<number[][]>; setDraft: Setter<number[][]>;
  draftRefs?: Accessor<(string | null)[]>; setDraftRefs?: (v: (string | null)[]) => void;
  snapIndex?: Accessor<VertexIndex>; snapRadiusImg?: Accessor<number>;
  brushSize: Accessor<number>;
  polylineStep?: (points: number[][], strokeWidth: number, refs: (string | null)[]) => void;
}): void {
  polylineClick(ix, iy, {
    draft: o.draft, setDraft: o.setDraft, brushSize: o.brushSize,
    draftRefs: o.draftRefs ?? (() => []), setDraftRefs: o.setDraftRefs ?? (() => {}),
    snapIndex: o.snapIndex ?? (() => EMPTY_INDEX), snapRadiusImg: o.snapRadiusImg ?? (() => 0),
    polylineStep: o.polylineStep ?? (() => {}),
  });
}
