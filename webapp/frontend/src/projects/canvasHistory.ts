/**
 * Client-only undo/redo stack for canvas annotations.
 *
 * Actions are backed by server-side soft-delete/restore via the mutate endpoint so the
 * server always has the authoritative state. The stack is reset on image/batch change and
 * is never persisted across page reload.
 *
 * Three action kinds:
 *  - 'draw'  — a plain create (point/line/polygon, or a brush stroke that fused with
 *    nothing). Undo/redo is a simple soft-delete/restore by id.
 *  - 'merge' — a brush stroke that FUSED with ≥1 existing live mask. The create minted a
 *    brand-new annotation and consumed the originals (see docs/plans/
 *    Plan — Annotation-stroke model (fused masks).md). Undo drives the server's
 *    /annotations/reverse endpoint (hard-deletes the created annotation+stroke,
 *    resurrects + repoints the consumed originals); redo just re-POSTs the ORIGINAL
 *    create request — since the originals are back exactly as they were, it re-derives
 *    the identical merge (new ids, so the stack entry is replaced with the fresh result).
 *  - 'erase' — a brush-eraser drag that soft-deleted whole annotations server-side already.
 *
 * Usage:
 *   const history = createCanvasHistory(getProjectId, updateCurrentImage);
 *   history.push({ kind: 'draw', ann });           // after a successful non-fusing commit
 *   history.push({ kind: 'merge', ... });           // after a fusing brush commit
 *   history.erase(annsToDelete);                   // eraser tool — does mutate + push
 *   await history.undo();
 *   await history.redo();
 *   history.canUndo();  history.canRedo();          // signals for button disabled state
 *   history.reset();                               // on image/batch navigation
 */

import { createSignal } from 'solid-js';
import type { CanvasAnnotation, CanvasImage, ConsumedGroup, TileStateUpdate } from './api';
import { projectsApi } from './api';
import { mergeTileStates } from './canvasShapes';

/** The exact body a brush create was POSTed with — kept on the `merge` action so redo can
 * re-issue the identical request. */
type CreateAnnotationBody = Parameters<typeof projectsApi.createAnnotation>[1];

export type HistoryAction =
  | { kind: 'draw'; ann: CanvasAnnotation }
  | { kind: 'merge'; ann: CanvasAnnotation; strokeId: string;
      consumedGroups: ConsumedGroup[]; redoBody: CreateAnnotationBody }
  | { kind: 'erase'; anns: CanvasAnnotation[] };

/** Minimal view-update callback: receives a transform function over the current image. */
type UpdateImg = (fn: (im: CanvasImage) => CanvasImage) => void;

function applyDelta(
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

export function createCanvasHistory(
  getProjectId: () => string,
  updateImg: UpdateImg,
) {
  const [stack, setStack] = createSignal<HistoryAction[]>([]);
  const [cursor, setCursor] = createSignal(0);

  const canUndo = () => cursor() > 0;
  const canRedo = () => cursor() < stack().length;

  /** Push an action after it has already been applied to the view (e.g. after a draw). */
  const push = (action: HistoryAction) => {
    setStack((s) => [...s.slice(0, cursor()), action]);
    setCursor((c) => c + 1);
  };

  /**
   * Erase a set of annotations: calls mutate(delete), updates the view, and pushes the
   * action. Retained for the erase/undo/redo symmetry tests; the brush eraser uses
   * `applyErase` below since its own request already deleted server-side.
   */
  const erase = async (anns: CanvasAnnotation[]) => {
    if (!anns.length) return;
    const ids = anns.map((a) => a.id);
    const r = await projectsApi.mutateAnnotations(getProjectId(), 'delete', ids);
    applyDelta(updateImg, [], ids, r.tileStates);
    push({ kind: 'erase', anns });
  };

  /**
   * Apply an eraser-brush drag that the server has ALREADY soft-deleted (one request
   * covers the whole drag, however many annotations it swept over). Updates the view and
   * pushes ONE `erase` action carrying every deleted annotation, so a single Ctrl+Z
   * restores all of them.
   */
  const applyErase = (anns: CanvasAnnotation[], tileStates: TileStateUpdate[] = []) => {
    if (!anns.length) return;
    applyDelta(updateImg, [], anns.map((a) => a.id), tileStates);
    push({ kind: 'erase', anns });
  };

  const undo = async () => {
    if (!canUndo()) return;
    const action = stack()[cursor() - 1];
    const pid = getProjectId();
    if (action.kind === 'draw') {
      const r = await projectsApi.mutateAnnotations(pid, 'delete', [action.ann.id]);
      applyDelta(updateImg, [], [action.ann.id], r.tileStates);
    } else if (action.kind === 'merge') {
      const r = await projectsApi.reverseMerge(pid, {
        annotationId: action.ann.id, strokeId: action.strokeId,
        consumedGroups: action.consumedGroups,
      });
      applyDelta(updateImg, r.resurrected, [action.ann.id], r.tileStates);
    } else {
      const ids = action.anns.map((a) => a.id);
      const r = await projectsApi.mutateAnnotations(pid, 'restore', ids);
      applyDelta(updateImg, action.anns, [], r.tileStates);
    }
    setCursor((c) => c - 1);
  };

  const redo = async () => {
    if (!canRedo()) return;
    const action = stack()[cursor()];
    const pid = getProjectId();
    if (action.kind === 'draw') {
      const r = await projectsApi.mutateAnnotations(pid, 'restore', [action.ann.id]);
      applyDelta(updateImg, [action.ann], [], r.tileStates);
    } else if (action.kind === 'merge') {
      // Replays the forward op (re-POST the original create) rather than a server-side
      // "redo" endpoint — the consumed originals are back exactly as they were after
      // undo, so this deterministically re-derives the same merge (new ids; the stack
      // entry below is refreshed so a LATER undo repoints against the right ids).
      const fresh = await projectsApi.createAnnotation(pid, action.redoBody);
      const consumedIds = action.consumedGroups.map((g) => g.annotationId);
      applyDelta(updateImg, [fresh], consumedIds, fresh.tileStates);
      const at = cursor();
      setStack((s) => s.map((a, i) => i === at
        ? { kind: 'merge', ann: fresh, strokeId: fresh.createdStrokeId,
            consumedGroups: fresh.consumedGroups, redoBody: action.redoBody }
        : a));
    } else {
      const ids = action.anns.map((a) => a.id);
      const r = await projectsApi.mutateAnnotations(pid, 'delete', ids);
      applyDelta(updateImg, [], ids, r.tileStates);
    }
    setCursor((c) => c + 1);
  };

  const reset = () => { setStack([]); setCursor(0); };

  return { push, erase, applyErase, undo, redo, canUndo, canRedo, reset };
}
