/**
 * Client-only undo/redo stack for canvas annotations.
 *
 * Actions are backed by server-side soft-delete/restore via the mutate op so the server
 * always has the authoritative state. The stack is reset on image/batch change and is
 * never persisted across page reload.
 *
 * Five action kinds:
 *  - 'draw'  — a plain create (point/line/polygon, or a brush stroke that fused with
 *    nothing). Undo/redo is a simple soft-delete/restore by id via the `mutate` op.
 *  - 'merge' — a brush stroke that FUSED with ≥1 existing live mask. The create minted a
 *    brand-new annotation and consumed the originals. Undo drives the `reverse_merge` op
 *    (hard-deletes the created annotation+stroke, resurrects the consumed originals);
 *    redo re-sends the ORIGINAL create request via the `create` op.
 *  - 'erase' — a brush-eraser drag that soft-deleted whole annotations server-side already.
 *  - 'relabel' — pure label change (label-only). Undo/redo just re-apply before/after
 *    via the `relabel` op.
 *  - 'edit'  — stroke vertex moved (a11y #40 v1b). Undo/redo delegate to
 *    canvasHistoryEdit.ts (`reverse` / `edit` ops; stack entry swap on redo).
 *
 * Phase 1+2 (feat/annotation-ws): ALL undo/redo ops (draw mutate, merge reverse_merge,
 * merge redo create, relabel, erase mutate, edit reverse/edit) route over the SHARED
 * socket (see canvasSocket.ts). They serialise strictly FIFO behind any pending polyline
 * persist ops on the same chain — the ordering fix for the polyline undo-determinism
 * race, extended to the whole mutation surface. `undo`/`redo` themselves also enqueue on
 * the socket chain (as a barrier) so a rapid Ctrl+Z waits for every in-flight click to
 * have applied before reading the history stack.
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

/** REST-bridge socket used ONLY when createCanvasHistory is called without a real
 * CanvasSocket (i.e. the unit tests in `e2e/unit/canvas*.spec.ts`, which
 * mock `globalThis.fetch` and call `createCanvasHistory(getProjectId, updateImg)`).
 *
 * Phase 1 used to return `{ok:false}` here and rely on the fact that no dispatch
 * path invoked `send` for the ops those tests exercised. Phase 2 routes EVERY undo
 * / redo / erase / relabel path through the socket, so the fallback now bridges
 * those op sends onto the same REST endpoints their fetch mocks still target — the
 * unit-test assertions (which inspect the POSTed body shape) keep passing verbatim.
 * Production always passes a real CanvasSocket from CanvasScreen, so this bridge is
 * inert outside tests. */
function _makeRestBridgeSocket(getProjectId: () => string): CanvasSocket {
  const send: SocketSend = async <T,>(op: string, payload: unknown) => {
    try {
      const pid = getProjectId();
      if (op === 'mutate') {
        const { op: mop, ids } = payload as { op: 'delete' | 'restore'; ids: string[] };
        const r = await projectsApi.mutateAnnotations(pid, mop, ids);
        return { ok: true as const, result: r as unknown as T };
      }
      if (op === 'relabel') {
        const { annotationId, label } = payload as { annotationId: string; label: string | null };
        const r = await projectsApi.updateAnnotation(annotationId, { label });
        return { ok: true as const, result: r as unknown as T };
      }
      if (op === 'reverse_merge') {
        const r = await projectsApi.reverseMerge(
          pid, payload as Parameters<typeof projectsApi.reverseMerge>[1]);
        return { ok: true as const, result: r as unknown as T };
      }
      if (op === 'erase') {
        const r = await projectsApi.eraseStroke(
          pid, payload as Parameters<typeof projectsApi.eraseStroke>[1]);
        return { ok: true as const, result: r as unknown as T };
      }
      if (op === 'create') {
        const r = await projectsApi.createAnnotation(
          pid, payload as Parameters<typeof projectsApi.createAnnotation>[1]);
        return { ok: true as const, result: r as unknown as T };
      }
      // edit / reverse (stroke vertex ops): no REST-bridge — Phase 1 already required
      // a real socket, and no unit test exercises those paths.
      return { ok: false as const,
        message: 'canvasHistory: no socket bound (edit/reverse unsupported in this context)' };
    } catch (ex) {
      return { ok: false as const, message: (ex as Error).message };
    }
  };
  return {
    send,
    enqueue: <T,>(task: (s: SocketSend) => Promise<T>): Promise<T> => task(send),
    close:   () => { /* no-op */ },
  };
}

export function createCanvasHistory(
  getProjectId: () => string,
  updateImg: UpdateImg,
  socket?: CanvasSocket,
) {
  const activeSocket: CanvasSocket = socket ?? _makeRestBridgeSocket(getProjectId);
  const [stack, setStack] = createSignal<HistoryAction[]>([]);
  const [cursor, setCursor] = createSignal(0);

  const canUndo = () => cursor() > 0;
  const canRedo = () => cursor() < stack().length;

  const push = (action: HistoryAction) => {
    setStack((s) => [...s.slice(0, cursor()), action]);
    setCursor((c) => c + 1);
  };

  /** Erase (via `mutate` op) + push — the imperative variant used by tests. Routed
   * through the shared socket so it observes the same FIFO ordering as every other
   * mutation (Phase 2). */
  const erase = async (anns: CanvasAnnotation[]) => {
    if (!anns.length) return;
    const ids = anns.map((a) => a.id);
    await activeSocket.enqueue(async (send: SocketSend) => {
      const ack = await send<{ ok: boolean; ids: string[]; tileStates: TileStateUpdate[] }>(
        'mutate', { op: 'delete', ids });
      if (!ack.ok) { alert(ack.message); return; }
      applyDelta(updateImg, [], ids, ack.result.tileStates);
      push({ kind: 'erase', anns });
    });
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
    await activeSocket.enqueue(async (send: SocketSend) => {
      if (!canUndo()) return;
      const action = stack()[cursor() - 1];
      const pid = getProjectId();
      await dispatchUndo(action, pid, updateImg, send);
      setCursor((c) => c - 1);
    });
  };

  const redo = async () => {
    if (!canRedo()) return;
    await activeSocket.enqueue(async (send: SocketSend) => {
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
