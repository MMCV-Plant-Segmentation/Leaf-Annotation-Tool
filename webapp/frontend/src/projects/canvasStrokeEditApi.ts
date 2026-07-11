/**
 * a11y #40 v1b: the /strokes/<id> edit + reverse endpoints. Split out of canvasApi.ts
 * so that file stays under the 200-line cap; spread into `canvasApi` at import time.
 *
 * `editStroke`  — PATCH /api/projects/<pid>/strokes/<sid>. Move a stroke's stored
 *   vertices; the server re-fuses all same-(annotator, image, label) strokes as
 *   connected components (so a mask may MOVE, SPLIT, or MERGE). Response splices the
 *   delta and carries a reversal descriptor (see `StrokeEditBefore`/`StrokeEditGroup`).
 *
 * `reverseStrokeEdit` — POST /api/projects/<pid>/strokes/<sid>/reverse. Reset the
 *   stroke to `before`, drop the minted masks, and resurrect the exact prior rows.
 *   Redo is a re-PATCH via `editStroke` (see canvasHistory.ts `edit` action).
 */
import type { CanvasAnnotation, TileStateUpdate } from './canvasApi';
import { jbody, jfetch } from './httpJson';

export type StrokeEditBefore = { points: number[][]; strokeWidth: number; outline: number[][] | null };
export type StrokeEditGroup = { annotationId: string; strokeIds: string[] };

export type EditStrokeResult = {
  ok: boolean;
  strokeId: string;
  before: StrokeEditBefore;
  deletedAnnotationIds: string[];
  deletedGroups: StrokeEditGroup[];
  created: CanvasAnnotation[];
  createdGroups: StrokeEditGroup[];
  tileStates: TileStateUpdate[];
};

export type ReverseStrokeEditResult = {
  ok: boolean;
  resurrected: CanvasAnnotation[];
  deletedAnnotationIds: string[];
  tileStates: TileStateUpdate[];
};

export const strokeEditApi = {
  editStroke: (projectId: string, strokeId: string,
    body: { points: number[][]; strokeWidth?: number; outline?: number[][] }) =>
    jfetch<EditStrokeResult>(
      `/api/projects/${projectId}/strokes/${strokeId}`, jbody('PATCH', body)),
  reverseStrokeEdit: (projectId: string, strokeId: string,
    body: { before: StrokeEditBefore; deletedGroups: StrokeEditGroup[]; createdAnnotationIds: string[] }) =>
    jfetch<ReverseStrokeEditResult>(
      `/api/projects/${projectId}/strokes/${strokeId}/reverse`, jbody('POST', body)),
};
