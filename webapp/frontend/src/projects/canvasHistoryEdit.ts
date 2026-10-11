/**
 * a11y #40 v1b: undo/redo handlers for the 'edit' history action. Split out of
 * canvasHistory.ts so that file stays under the 200-line cap; the API surface is a
 * pair of pure async helpers the history's undo/redo dispatch delegates into.
 *
 * Phase 1 (feat/annotation-ws): these now route through the SHARED socket (see
 * canvasSocket.ts) via the `send` callback — `reverse` and `edit` server ops go over
 * the SAME ordered channel as create/edit-per-click, so an in-flight polyline click's
 * ack always applies before an undo runs on it.
 *
 * The `applyDelta` callback matches canvasHistoryApply.applyDelta — it drives the view
 * update (add/remove annotations + patch tile states) so this module needn't know how
 * the caller renders. `swap` is used by redo to refresh the stack entry with the fresh
 * delta (so a LATER undo repoints against the right ids — same trick as merge redo).
 */
import type { CanvasAnnotation, TileStateUpdate, StrokeEditBefore, StrokeEditGroup } from './api';
import type { SocketSend } from './canvasSocket';
import type { EditStrokeResult, ReverseStrokeEditResult } from './canvasStrokeEditApi';

export type EditAction = {
  kind: 'edit';
  strokeId: string;
  before: StrokeEditBefore;
  deletedGroups: StrokeEditGroup[];
  created: CanvasAnnotation[];
  redoBody: { strokeId?: string; points: number[][]; strokeWidth?: number; outline?: number[][] };
};

type ApplyDelta = (add: CanvasAnnotation[], removeIds: string[], tileStates: TileStateUpdate[]) => void;

export async function editUndo(
  action: EditAction, apply: ApplyDelta, send: SocketSend,
): Promise<void> {
  const ack = await send<ReverseStrokeEditResult>('reverse', {
    strokeId: action.strokeId,
    before: action.before, deletedGroups: action.deletedGroups,
    createdAnnotationIds: action.created.map((a) => a.id),
  });
  if (!ack.ok) { alert(ack.message); return; }
  apply(ack.result.resurrected, action.created.map((a) => a.id), ack.result.tileStates);
}

export async function editRedo(
  action: EditAction, apply: ApplyDelta, swap: (fresh: EditAction) => void, send: SocketSend,
): Promise<void> {
  // Ensure strokeId ships in the op payload (REST-side it lived in the URL).
  const body = { ...action.redoBody, strokeId: action.strokeId };
  const ack = await send<EditStrokeResult>('edit', body);
  if (!ack.ok) { alert(ack.message); return; }
  const fresh = ack.result;
  // Remove what the re-PATCH actually deleted (the live, resurrected originals) — NOT the
  // long-gone original-minted ids, which aren't in the view after the preceding undo.
  apply(fresh.created, fresh.deletedAnnotationIds, fresh.tileStates);
  swap({
    kind: 'edit', strokeId: action.strokeId, before: fresh.before,
    deletedGroups: fresh.deletedGroups, created: fresh.created, redoBody: body,
  });
}
