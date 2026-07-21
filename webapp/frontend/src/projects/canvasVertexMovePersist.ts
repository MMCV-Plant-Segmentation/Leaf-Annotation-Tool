/**
 * t50 phase 3b: the `moveSharedVertex` op — split out of canvasPersistence.ts so that
 * file stays under the 200-line cap (mirrors the canvasHistoryEdit.ts / canvasPolylinePersist.ts
 * split pattern). Sends the `moveVertex` WS op (phase 3a's `do_move_vertex`, which moves a
 * SHARED vertex and re-fuses every referencing annotation) and applies the result the same
 * way `applyEdit` does: drop the deleted ids, splice in the re-fused annotations, merge tile
 * states — then push an undoable `vertexMove` history entry carrying before/after.
 */
import type { CanvasAnnotation, TileStateUpdate } from './api';
import type { CanvasSocket } from './canvasSocket';
import type { createCanvasHistory } from './canvasHistory';
import type { UpdateImg } from './canvasHistoryApply';
import { mergeTileStates } from './canvasShapes';

export type Point = { x: number; y: number };

/** Response shape of the `moveVertex` op (mirrors PATCH .../vertices/<id>). */
export type MoveVertexResult = {
  vertexId: string; x: number; y: number;
  deletedAnnotationIds: string[];
  annotations: CanvasAnnotation[];
  tileStates: TileStateUpdate[];
};

export interface VertexMoveDeps {
  socket: CanvasSocket;
  updateImg: UpdateImg;
  history: ReturnType<typeof createCanvasHistory>;
  /** Migrate the selection onto the re-fused mask (the move deletes + re-mints it), so the
   *  highlight + vertex handles follow instead of sticking on the dead id (mirrors editStroke). */
  setSelectedId?: (id: string) => void;
}

export function createMoveSharedVertex(o: VertexMoveDeps) {
  return async (vertexId: string, before: Point, after: Point): Promise<void> => {
    await o.socket.enqueue(async (send) => {
      const ack = await send<MoveVertexResult>('moveVertex', { vertexId, x: after.x, y: after.y });
      if (!ack.ok) { alert(ack.message); return; }
      const r = ack.result;
      o.updateImg((im) => ({
        ...im,
        annotations: [
          ...im.annotations.filter((a) => !r.deletedAnnotationIds.includes(a.id)),
          ...r.annotations,
        ],
        tiles: mergeTileStates(im.tiles, r.tileStates),
      }));
      // The move re-mints every affected mask; re-select the one that still carries the moved
      // vertex so its handles/highlight resolve (else the selection sticks on the deleted id).
      const target = r.annotations.find(
        (a) => a.strokes?.some((s) => (s.vertexIds ?? []).includes(vertexId))) ?? r.annotations[0];
      if (target) o.setSelectedId?.(target.id);
      o.history.push({ kind: 'vertexMove', vertexId, before, after });
    });
  };
}
