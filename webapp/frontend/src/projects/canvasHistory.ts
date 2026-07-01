/**
 * Client-only undo/redo stack for canvas annotations.
 *
 * Actions are backed by server-side soft-delete/restore via the mutate endpoint so the
 * server always has the authoritative state. The stack is reset on image/batch change and
 * is never persisted across page reload.
 *
 * Usage:
 *   const history = createCanvasHistory(getProjectId, updateCurrentImage);
 *   history.push({ kind: 'draw', ann });           // after a successful stroke commit
 *   history.erase(annsToDelete);                   // eraser tool — does mutate + push
 *   await history.undo();
 *   await history.redo();
 *   history.canUndo();  history.canRedo();          // signals for button disabled state
 *   history.reset();                               // on image/batch navigation
 */

import { createSignal } from 'solid-js';
import type { CanvasAnnotation, CanvasImage, CanvasLesion, TileStateUpdate } from './api';
import { projectsApi } from './api';
import { mergeTileStates } from './canvasShapes';

export type HistoryAction =
  | { kind: 'draw'; ann: CanvasAnnotation }
  | { kind: 'erase'; anns: CanvasAnnotation[] };

/** Minimal view-update callback: receives a transform function over the current image. */
type UpdateImg = (fn: (im: CanvasImage) => CanvasImage) => void;

function applyDelta(
  updateImg: UpdateImg,
  lesions: CanvasLesion[],
  add: CanvasAnnotation[],
  removeIds: string[],
  tileStates: TileStateUpdate[] = [],
): void {
  updateImg((im) => ({
    ...im,
    lesions,
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
    applyDelta(updateImg, r.lesions, [], ids, r.tileStates);
    push({ kind: 'erase', anns });
  };

  /**
   * Apply an eraser-brush drag that the server has ALREADY soft-deleted (one request
   * covers the whole drag, however many strokes it swept over). Updates the view and
   * pushes ONE `erase` action carrying every deleted annotation, so a single Ctrl+Z
   * restores all of them.
   */
  const applyErase = (
    anns: CanvasAnnotation[],
    lesions: CanvasLesion[],
    tileStates: TileStateUpdate[] = [],
  ) => {
    if (!anns.length) return;
    applyDelta(updateImg, lesions, [], anns.map((a) => a.id), tileStates);
    push({ kind: 'erase', anns });
  };

  const undo = async () => {
    if (!canUndo()) return;
    const action = stack()[cursor() - 1];
    const pid = getProjectId();
    if (action.kind === 'draw') {
      const r = await projectsApi.mutateAnnotations(pid, 'delete', [action.ann.id]);
      applyDelta(updateImg, r.lesions, [], [action.ann.id], r.tileStates);
    } else {
      const ids = action.anns.map((a) => a.id);
      const r = await projectsApi.mutateAnnotations(pid, 'restore', ids);
      applyDelta(updateImg, r.lesions, action.anns, [], r.tileStates);
    }
    setCursor((c) => c - 1);
  };

  const redo = async () => {
    if (!canRedo()) return;
    const action = stack()[cursor()];
    const pid = getProjectId();
    if (action.kind === 'draw') {
      const r = await projectsApi.mutateAnnotations(pid, 'restore', [action.ann.id]);
      applyDelta(updateImg, r.lesions, [action.ann], [], r.tileStates);
    } else {
      const ids = action.anns.map((a) => a.id);
      const r = await projectsApi.mutateAnnotations(pid, 'delete', ids);
      applyDelta(updateImg, r.lesions, [], ids, r.tileStates);
    }
    setCursor((c) => c + 1);
  };

  const reset = () => { setStack([]); setCursor(0); };

  return { push, erase, applyErase, undo, redo, canUndo, canRedo, reset };
}
