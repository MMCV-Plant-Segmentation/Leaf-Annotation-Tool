/**
 * t50 phase 3b: undo/redo handlers for the 'vertexMove' history action. Split out of
 * canvasHistory.ts so that file stays under the 200-line cap (mirrors canvasHistoryEdit.ts's
 * split for 'edit'). Undo re-sends `moveVertex` to `before`; redo re-sends to `after` — both
 * apply the returned re-fused annotations the same way `moveSharedVertex` does.
 */
import type { TileStateUpdate } from './api';
import type { SocketSend } from './canvasSocket';
import type { MoveVertexResult, Point } from './canvasVertexMovePersist';

export type VertexMoveAction = {
  kind: 'vertexMove';
  vertexId: string;
  before: Point;
  after: Point;
};

type ApplyDelta = (add: MoveVertexResult['annotations'], removeIds: string[], tileStates: TileStateUpdate[]) => void;

async function _sendMove(vertexId: string, to: Point, apply: ApplyDelta, send: SocketSend): Promise<void> {
  const ack = await send<MoveVertexResult>('moveVertex', { vertexId, x: to.x, y: to.y });
  if (!ack.ok) { alert(ack.message); return; }
  const r = ack.result;
  apply(r.annotations, r.deletedAnnotationIds, r.tileStates);
}

export async function vertexMoveUndo(
  action: VertexMoveAction, apply: ApplyDelta, send: SocketSend,
): Promise<void> {
  await _sendMove(action.vertexId, action.before, apply, send);
}

export async function vertexMoveRedo(
  action: VertexMoveAction, apply: ApplyDelta, send: SocketSend,
): Promise<void> {
  await _sendMove(action.vertexId, action.after, apply, send);
}
