/**
 * Undo/redo dispatch bodies — extracted from canvasHistory.ts so that file stays under
 * the 200-line cap. Branches on `action.kind` and drives the right WS op via the
 * socket's raw `send` fn. Phase 2 (feat/annotation-ws): EVERY branch — draw
 * undo/redo (`mutate`), merge undo (`reverse_merge`), merge redo (`create`), relabel
 * undo/redo (`relabel`), erase undo/redo (`mutate`), plus edit undo/redo — flows over
 * the SAME single ordered channel, so a rapid Ctrl+Z always serialises behind any
 * in-flight per-click polyline op.
 */
import type { CanvasAnnotation, CreateAnnotationResult, TileStateUpdate } from './api';
import { editUndo, editRedo } from './canvasHistoryEdit';
import { vertexMoveUndo, vertexMoveRedo } from './canvasHistoryVertexMove';
import type { SocketSend } from './canvasSocket';
import type { HistoryAction } from './canvasHistory';
import { applyDelta, applyRelabel, type UpdateImg } from './canvasHistoryApply';

/** Bulk delete/restore result — mirrors the REST /annotations/mutate response. */
type MutateResult = { ok: boolean; ids: string[]; tileStates: TileStateUpdate[] };
/** Merge-undo result — mirrors the REST /annotations/reverse response. */
type ReverseMergeResult = { ok: boolean; resurrected: CanvasAnnotation[];
  deletedAnnotationId: string; tileStates: TileStateUpdate[] };

export async function dispatchUndo(
  action: HistoryAction,
  _pid: string,
  updateImg: UpdateImg,
  send: SocketSend,
): Promise<void> {
  if (action.kind === 'draw') {
    const ack = await send<MutateResult>('mutate', { op: 'delete', ids: [action.ann.id] });
    if (!ack.ok) { alert(ack.message); return; }
    applyDelta(updateImg, [], [action.ann.id], ack.result.tileStates);
  } else if (action.kind === 'merge') {
    const ack = await send<ReverseMergeResult>('reverse_merge', {
      annotationId: action.ann.id, strokeId: action.strokeId,
      consumedGroups: action.consumedGroups,
    });
    if (!ack.ok) { alert(ack.message); return; }
    applyDelta(updateImg, ack.result.resurrected, [action.ann.id], ack.result.tileStates);
  } else if (action.kind === 'relabel') {
    const ack = await send<CanvasAnnotation>('relabel',
      { annotationId: action.annotationId, label: action.before });
    if (!ack.ok) { alert(ack.message); return; }
    applyRelabel(updateImg, ack.result);
  } else if (action.kind === 'edit') {
    await editUndo(action, (add, rm, ts) => applyDelta(updateImg, add, rm, ts), send);
  } else if (action.kind === 'vertexMove') {
    await vertexMoveUndo(action, (add, rm, ts) => applyDelta(updateImg, add, rm, ts), send);
  } else {
    const ids = action.anns.map((a: CanvasAnnotation) => a.id);
    const ack = await send<MutateResult>('mutate', { op: 'restore', ids });
    if (!ack.ok) { alert(ack.message); return; }
    applyDelta(updateImg, action.anns, [], ack.result.tileStates);
  }
}

export async function dispatchRedo(
  action: HistoryAction,
  _pid: string,
  at: number,
  updateImg: UpdateImg,
  setStack: (fn: (s: HistoryAction[]) => HistoryAction[]) => void,
  send: SocketSend,
): Promise<void> {
  if (action.kind === 'draw') {
    const ack = await send<MutateResult>('mutate', { op: 'restore', ids: [action.ann.id] });
    if (!ack.ok) { alert(ack.message); return; }
    applyDelta(updateImg, [action.ann], [], ack.result.tileStates);
  } else if (action.kind === 'merge') {
    // Re-send the original create — the consumed originals are back exactly as they
    // were after undo, so this deterministically re-derives the same merge (fresh
    // ids; the stack entry is refreshed so a LATER undo repoints against them).
    const ack = await send<CreateAnnotationResult>('create', action.redoBody);
    if (!ack.ok) { alert(ack.message); return; }
    const fresh = ack.result;
    const consumedIds = action.consumedGroups.map((g) => g.annotationId);
    applyDelta(updateImg, [fresh], consumedIds, fresh.tileStates);
    setStack((s) => s.map((a, i) => i === at
      ? { kind: 'merge', ann: fresh, strokeId: fresh.createdStrokeId,
          consumedGroups: fresh.consumedGroups, redoBody: action.redoBody }
      : a));
  } else if (action.kind === 'relabel') {
    const ack = await send<CanvasAnnotation>('relabel',
      { annotationId: action.annotationId, label: action.after });
    if (!ack.ok) { alert(ack.message); return; }
    applyRelabel(updateImg, ack.result);
  } else if (action.kind === 'edit') {
    await editRedo(action,
      (add, rm, ts) => applyDelta(updateImg, add, rm, ts),
      (fresh) => setStack((s) => s.map((a, i) => i === at ? fresh : a)),
      send);
  } else if (action.kind === 'vertexMove') {
    await vertexMoveRedo(action, (add, rm, ts) => applyDelta(updateImg, add, rm, ts), send);
  } else {
    const ids = action.anns.map((a: CanvasAnnotation) => a.id);
    const ack = await send<MutateResult>('mutate', { op: 'delete', ids });
    if (!ack.ok) { alert(ack.message); return; }
    applyDelta(updateImg, [], ids, ack.result.tileStates);
  }
}
