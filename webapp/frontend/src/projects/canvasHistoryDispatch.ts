/**
 * Undo/redo dispatch bodies — extracted from canvasHistory.ts so that file stays under
 * the 200-line cap. Branches on `action.kind` and drives the right REST call or WS op.
 * `send` is the socket's raw send fn — the ONE way `edit` / `reverse` ops flow, so
 * ordering matches the pending polyline persist chain.
 */
import type { CanvasAnnotation } from './api';
import { projectsApi } from './api';
import { editUndo, editRedo } from './canvasHistoryEdit';
import type { SocketSend } from './canvasSocket';
import type { HistoryAction } from './canvasHistory';
import { applyDelta, applyRelabel, type UpdateImg } from './canvasHistoryApply';

export async function dispatchUndo(
  action: HistoryAction,
  pid: string,
  updateImg: UpdateImg,
  send: SocketSend,
): Promise<void> {
  if (action.kind === 'draw') {
    const r = await projectsApi.mutateAnnotations(pid, 'delete', [action.ann.id]);
    applyDelta(updateImg, [], [action.ann.id], r.tileStates);
  } else if (action.kind === 'merge') {
    const r = await projectsApi.reverseMerge(pid, {
      annotationId: action.ann.id, strokeId: action.strokeId,
      consumedGroups: action.consumedGroups,
    });
    applyDelta(updateImg, r.resurrected, [action.ann.id], r.tileStates);
  } else if (action.kind === 'relabel') {
    const updated = await projectsApi.updateAnnotation(action.annotationId, { label: action.before });
    applyRelabel(updateImg, updated);
  } else if (action.kind === 'edit') {
    await editUndo(action, (add, rm, ts) => applyDelta(updateImg, add, rm, ts), send);
  } else {
    const ids = action.anns.map((a: CanvasAnnotation) => a.id);
    const r = await projectsApi.mutateAnnotations(pid, 'restore', ids);
    applyDelta(updateImg, action.anns, [], r.tileStates);
  }
}

export async function dispatchRedo(
  action: HistoryAction,
  pid: string,
  at: number,
  updateImg: UpdateImg,
  setStack: (fn: (s: HistoryAction[]) => HistoryAction[]) => void,
  send: SocketSend,
): Promise<void> {
  if (action.kind === 'draw') {
    const r = await projectsApi.mutateAnnotations(pid, 'restore', [action.ann.id]);
    applyDelta(updateImg, [action.ann], [], r.tileStates);
  } else if (action.kind === 'merge') {
    // Re-POST the original create — the consumed originals are back exactly as they
    // were after undo, so this deterministically re-derives the same merge (fresh
    // ids; the stack entry is refreshed so a LATER undo repoints against them).
    const fresh = await projectsApi.createAnnotation(pid, action.redoBody);
    const consumedIds = action.consumedGroups.map((g) => g.annotationId);
    applyDelta(updateImg, [fresh], consumedIds, fresh.tileStates);
    setStack((s) => s.map((a, i) => i === at
      ? { kind: 'merge', ann: fresh, strokeId: fresh.createdStrokeId,
          consumedGroups: fresh.consumedGroups, redoBody: action.redoBody }
      : a));
  } else if (action.kind === 'relabel') {
    const updated = await projectsApi.updateAnnotation(action.annotationId, { label: action.after });
    applyRelabel(updateImg, updated);
  } else if (action.kind === 'edit') {
    await editRedo(action,
      (add, rm, ts) => applyDelta(updateImg, add, rm, ts),
      (fresh) => setStack((s) => s.map((a, i) => i === at ? fresh : a)),
      send);
  } else {
    const ids = action.anns.map((a: CanvasAnnotation) => a.id);
    const r = await projectsApi.mutateAnnotations(pid, 'delete', ids);
    applyDelta(updateImg, [], ids, r.tileStates);
  }
}
