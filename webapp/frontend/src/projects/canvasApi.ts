// Canvas annotation types + the annotation-mutation API surface — split out of api.ts
// to keep it ≤200 lines. Re-exported from api.ts so `projectsApi.createAnnotation(...)`
// etc. keep working unchanged for every existing caller.
import type { Rect, Label } from './api';
import { jbody, jfetch } from './httpJson';

export type CanvasTile = Rect & {
  tileId: string;
  batchTileId: string;
  annotatorTileId: string | null;
  state: 'assigned' | 'completed' | 'dirty' | null;
};

/** A tile flipped server-side as a side effect of an annotation mutation (BUGS #16:
 * editing a completed tile re-opens it) — enough for the FE to patch its local state. */
export type TileStateUpdate = { tileId: string; annotatorTileId: string; state: 'dirty' };

/** A persisted annotation (mask). kind='stroke' renders from `rings` (the fused,
 * hole-less exterior ring the server stores — never recomputed client-side); other
 * kinds never fuse, so they render from their own `points`, same as before. */
export type CanvasAnnotation = {
  id: string;
  kind: string;
  passNo: number | null;
  points: number[][];
  rings: number[][][];
  label: string | null;
  viewport: Rect | null;
  annotator: string;
  imageId: string;
};

export type CanvasImage = {
  imageId: string;
  width: number;
  height: number;
  tiles: CanvasTile[];
  annotations: CanvasAnnotation[];
};

export type BatchCanvas = {
  id: string;
  projectId: string;
  seq: number;
  status: string;
  classes: Label[];
  images: CanvasImage[];
};

/** One fuse-set member a brush create/merge consumed — carries enough to repoint its
 * strokes back on undo (see canvasHistory.ts's `merge` action). */
export type ConsumedGroup = { annotationId: string; strokeIds: string[] };

export type CreateAnnotationResult = CanvasAnnotation & {
  tileIds: string[];
  tileStates: TileStateUpdate[];
  /** Non-empty only for a brush stroke that fused with existing live mask(s). */
  consumedAnnotationIds: string[];
  createdStrokeId: string;
  consumedGroups: ConsumedGroup[];
};

export const canvasApi = {
  batchCanvas: (batchId: string, annotator: string) =>
    jfetch<BatchCanvas>(`/api/batches/${batchId}?annotator=${encodeURIComponent(annotator)}`),

  createAnnotation: (projectId: string, body: {
    imageId: string; annotator: string; kind: string; points: number[][];
    passNo?: number; label?: string; viewport?: Rect; hsvHist?: unknown;
    strokeWidth?: number; outline?: number[][];
  }) => jfetch<CreateAnnotationResult>(`/api/projects/${projectId}/annotations`, jbody('POST', body)),
  updateAnnotation: (annotationId: string, body: { points?: number[][]; label?: string }) =>
    jfetch<CanvasAnnotation>(`/api/annotations/${annotationId}`, jbody('PATCH', body)),
  deleteAnnotation: (annotationId: string) =>
    jfetch<{ ok: boolean; tileStates: TileStateUpdate[] }>(`/api/annotations/${annotationId}`, { method: 'DELETE' }),
  mutateAnnotations: (projectId: string, op: 'delete' | 'restore', ids: string[]) =>
    jfetch<{ ok: boolean; ids: string[]; tileStates: TileStateUpdate[] }>(
      `/api/projects/${projectId}/annotations/mutate`, jbody('POST', { op, ids })),
  eraseStroke: (projectId: string, body: { imageId: string; annotator: string; points: number[][]; strokeWidth?: number; outline?: number[][] }) =>
    jfetch<{ deletedAnnotationIds: string[]; tileStates: TileStateUpdate[] }>(
      `/api/projects/${projectId}/annotations/erase-stroke`, jbody('POST', body)),
  /** Undo a brush create/merge: hard-deletes the created annotation+stroke server-side
   * and resurrects (+repoints) every consumed original. Redo is just re-POSTing the
   * original createAnnotation body (see canvasHistory.ts). */
  reverseMerge: (projectId: string, body: { annotationId: string; strokeId: string; consumedGroups: ConsumedGroup[] }) =>
    jfetch<{ ok: boolean; resurrected: CanvasAnnotation[]; deletedAnnotationId: string; tileStates: TileStateUpdate[] }>(
      `/api/projects/${projectId}/annotations/reverse`, jbody('POST', body)),

  setTileState: (annotatorTileId: string, state: 'assigned' | 'completed' | 'dirty') =>
    jfetch<{ ok: boolean; state: string }>(`/api/annotator-tiles/${annotatorTileId}`, jbody('PATCH', { state })),

  /** Batch-insert viewport (pan/zoom) telemetry samples — see viewportTelemetry.ts.
   * Best-effort by design: callers swallow rejections, never surface them to the user. */
  postViewportEvents: (projectId: string, body: { imageId: string; events: ViewportSample[] }) =>
    jfetch<{ ok: boolean; count: number }>(`/api/projects/${projectId}/viewport-events`, jbody('POST', body)),
};

/** One captured canvas viewport sample — wire shape for postViewportEvents. See
 * viewportTelemetry.ts for how samples are gathered/batched. */
export type ViewportSample = {
  clientTs: string; x: number; y: number; w: number; h: number;
  cssW: number; cssH: number; dpr: number;
};
