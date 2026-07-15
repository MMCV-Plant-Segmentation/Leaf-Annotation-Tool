/**
 * Client-only undo/redo stack for canvas annotations.
 *
 * Actions are backed by server-side soft-delete/restore via the mutate endpoint so the
 * server always has the authoritative state. The stack is reset on image/batch change and
 * is never persisted across page reload.
 *
 * Five action kinds:
 *  - 'draw'  — a plain create (point/line/polygon, or a brush stroke that fused with
 *    nothing). Undo/redo is a simple soft-delete/restore by id.
 *  - 'merge' — a brush stroke that FUSED with ≥1 existing live mask. The create minted a
 *    brand-new annotation and consumed the originals. Undo drives /annotations/reverse
 *    (hard-deletes the created annotation+stroke, resurrects the consumed originals);
 *    redo re-POSTs the ORIGINAL create request.
 *  - 'erase' — a brush-eraser drag that soft-deleted whole annotations server-side already.
 *  - 'relabel' — pure label change (label-only PATCH). Undo/redo just re-apply
 *    before/after via the same PATCH.
 *  - 'edit'  — stroke vertex moved (a11y #40 v1b). Undo/redo delegate to
 *    canvasHistoryEdit.ts (reverse endpoint / re-PATCH; stack entry swap on redo).
 *
 * Phase 1 (feat/annotation-ws): edit-undo (server op `reverse`) + edit-redo (server op
 * `edit`) route over the SHARED socket (see canvasSocket.ts) so they serialise strictly
 * FIFO behind any pending polyline persist ops — the ordering fix for the polyline
 * undo-determinism race. `undo`/`redo` themselves also enqueue on the socket chain (as
 * a barrier) so a rapid Ctrl+Z waits for every in-flight click to have applied before
 * reading the history stack.
 *
 * Usage:
 *   const history = createCanvasHistory(getProjectId, updateCurrentImage, socket);
 *   history.push({ kind: 'draw', ann });
 *   await history.undo();  await history.redo();
 *   history.canUndo();  history.canRedo();
 *   history.reset();
 */

import { createSignal } from 'solid-js';
import type { CanvasAnnotation, ConsumedGroup, TileStateUpdate,
  StrokeEditBefore, StrokeEditGroup } from './api';
import { projectsApi } from './api';
import type { CanvasSocket, SocketSend } from './canvasSocket';
import type { UpdateImg } from './canvasHistoryApply';
import { applyDelta } from './canvasHistoryApply';
import { dispatchUndo, dispatchRedo } from './canvasHistoryDispatch';

/** Bodies kept on `merge`/`edit` actions so redo can re-issue the identical request. */
type CreateAnnotationBody = Parameters<typeof projectsApi.createAnnotation>[1];
type EditStrokeBody = { strokeId?: string; points: number[][]; strokeWidth?: number; outline?: number[][] };

export type HistoryAction =
  | { kind: 'draw'; ann: CanvasAnnotation }
  | { kind: 'merge'; ann: CanvasAnnotation; strokeId: string;
      consumedGroups: ConsumedGroup[]; redoBody: CreateAnnotationBody }
  | { kind: 'erase'; anns: CanvasAnnotation[] }
  | { kind: 'relabel'; annotationId: string; before: string | null; after: string | null }
  | { kind: 'edit'; strokeId: string; before: StrokeEditBefore; deletedGroups: StrokeEditGroup[];
      created: CanvasAnnotation[]; redoBody: EditStrokeBody };

/** Synthetic "no socket" fallback used by unit tests that call createCanvasHistory with
 * only (getProjectId, updateImg). Runs the enqueue task inline with a stub send that
 * always errors — draw/erase/relabel dispatch don't invoke `send` at all (they use REST
 * via projectsApi), so those unit tests keep passing unchanged; only the `edit` action's
 * WS-dependent path (not exercised in these tests) would surface the error. Production
 * always passes a real CanvasSocket from CanvasScreen. */
const _fallbackSend: SocketSend = async () => ({ ok: false, message: 'canvasHistory: no socket bound (edit undo/redo unsupported in this context)' });
const FALLBACK_SOCKET: CanvasSocket = {
  send:    _fallbackSend,
  enqueue: async <T,>(task: (s: SocketSend) => Promise<T>): Promise<T> => task(_fallbackSend),
  close:   () => { /* no-op */ },
};

export function createCanvasHistory(
  getProjectId: () => string,
  updateImg: UpdateImg,
  socket: CanvasSocket = FALLBACK_SOCKET,
) {
  const [stack, setStack] = createSignal<HistoryAction[]>([]);
  const [cursor, setCursor] = createSignal(0);

  const canUndo = () => cursor() > 0;
  const canRedo = () => cursor() < stack().length;

  const push = (action: HistoryAction) => {
    setStack((s) => [...s.slice(0, cursor()), action]);
    setCursor((c) => c + 1);
  };

  /** Erase (via mutate) + push — the imperative variant used by tests. */
  const erase = async (anns: CanvasAnnotation[]) => {
    if (!anns.length) return;
    const ids = anns.map((a) => a.id);
    const r = await projectsApi.mutateAnnotations(getProjectId(), 'delete', ids);
    applyDelta(updateImg, [], ids, r.tileStates);
    push({ kind: 'erase', anns });
  };

  /** Apply the eraser-brush server delta (already soft-deleted) + push ONE erase entry. */
  const applyErase = (anns: CanvasAnnotation[], tileStates: TileStateUpdate[] = []) => {
    if (!anns.length) return;
    applyDelta(updateImg, [], anns.map((a) => a.id), tileStates);
    push({ kind: 'erase', anns });
  };

  const undo = async () => {
    if (!canUndo()) return;
    // Enqueue on the shared socket chain — the ordering barrier that makes Ctrl+Z wait
    // for every in-flight per-click polyline edit to have applied. Without it a fast
    // Ctrl+Z could dispatch against a not-yet-populated history stack.
    await socket.enqueue(async (send: SocketSend) => {
      if (!canUndo()) return;
      const action = stack()[cursor() - 1];
      const pid = getProjectId();
      await dispatchUndo(action, pid, updateImg, send);
      setCursor((c) => c - 1);
    });
  };

  const redo = async () => {
    if (!canRedo()) return;
    await socket.enqueue(async (send: SocketSend) => {
      if (!canRedo()) return;
      const at = cursor();
      const action = stack()[at];
      const pid = getProjectId();
      await dispatchRedo(action, pid, at, updateImg, setStack, send);
      setCursor((c) => c + 1);
    });
  };

  const reset = () => { setStack([]); setCursor(0); };

  return { push, erase, applyErase, undo, redo, canUndo, canRedo, reset };
}
