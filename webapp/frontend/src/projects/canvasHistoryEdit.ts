/**
 * a11y #40 v1b: undo/redo handlers for the 'edit' history action. Split out of
 * canvasHistory.ts so that file stays under the 200-line cap; the API surface is a
 * pair of pure async helpers the history's undo/redo dispatch delegates into.
 *
 * The `applyDelta` callback matches canvasHistory.ts's local helper — it drives the
 * view update (add/remove annotations + patch tile states) so this module needn't
 * know how the caller renders. `swap` is used by redo to refresh the stack entry
 * with the fresh delta (so a LATER undo repoints against the right ids — same trick
 * as the merge redo does).
 */
import type { CanvasAnnotation, TileStateUpdate, StrokeEditBefore, StrokeEditGroup } from './api';
import { projectsApi } from './api';

export type EditAction = {
  kind: 'edit';
  strokeId: string;
  before: StrokeEditBefore;
  deletedGroups: StrokeEditGroup[];
  created: CanvasAnnotation[];
  redoBody: { points: number[][]; strokeWidth?: number; outline?: number[][] };
};

type ApplyDelta = (add: CanvasAnnotation[], removeIds: string[], tileStates: TileStateUpdate[]) => void;

export async function editUndo(pid: string, action: EditAction, apply: ApplyDelta): Promise<void> {
  const r = await projectsApi.reverseStrokeEdit(pid, action.strokeId, {
    before: action.before, deletedGroups: action.deletedGroups,
    createdAnnotationIds: action.created.map((a) => a.id),
  });
  apply(r.resurrected, action.created.map((a) => a.id), r.tileStates);
}

export async function editRedo(
  pid: string, action: EditAction, apply: ApplyDelta, swap: (fresh: EditAction) => void,
): Promise<void> {
  const fresh = await projectsApi.editStroke(pid, action.strokeId, action.redoBody);
  // Remove what the re-PATCH actually deleted (the live, resurrected originals) — NOT the
  // long-gone original-minted ids, which aren't in the view after the preceding undo.
  apply(fresh.created, fresh.deletedAnnotationIds, fresh.tileStates);
  swap({
    kind: 'edit', strokeId: action.strokeId, before: fresh.before,
    deletedGroups: fresh.deletedGroups, created: fresh.created, redoBody: action.redoBody,
  });
}
