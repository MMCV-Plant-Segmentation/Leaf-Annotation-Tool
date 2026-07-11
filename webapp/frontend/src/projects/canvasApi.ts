// Canvas annotation types + the annotation-mutation API surface — split out of api.ts
// to keep it ≤200 lines. Re-exported from api.ts so `projectsApi.createAnnotation(...)`
// etc. keep working unchanged for every existing caller.
import type { Rect, Label } from './api';
import type { Group, Compound, LabelSnapshot } from './taxonomy';
import { jbody, jfetch } from './httpJson';
import { strokeEditApi } from './canvasStrokeEditApi';
export type { StrokeEditBefore, StrokeEditGroup } from './canvasStrokeEditApi';

export type CanvasTile = Rect & {
  tileId: string;
  batchTileId: string;
  annotatorTileId: string | null;
  state: 'assigned' | 'completed' | 'dirty' | null;
};

/** A tile flipped server-side as a side effect of an annotation mutation (BUGS #16:
 * editing a completed tile re-opens it) — enough for the FE to patch its local state. */
export type TileStateUpdate = { tileId: string; annotatorTileId: string; state: 'dirty' };

/** One member stroke of a fused mask (a11y #40 v1b — `tool` picks the outline
 * builder on vertex-edit drop: polyline → polylineOutline, brush → perfect-freehand). */
export type CanvasStroke = { id: string; tool: string; points: number[][]; strokeWidth: number };

/** A persisted annotation (mask). kind='stroke' renders from `rings` (fused, hole-less
 * exterior ring the server stores); other kinds render from their own `points`.
 * `strokes` is opt-in server-side and drives the vertex-edit handles when selected. */
export type CanvasAnnotation = {
  id: string;
  kind: string;
  passNo: number | null;
  points: number[][];
  rings: number[][][];
  label: string | null;
  labelColor: string | null;
  labelSnapshot: LabelSnapshot | null;
  viewport: Rect | null;
  annotator: string;
  imageId: string;
  strokes?: CanvasStroke[];
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
  /** MERGE Phase 1 gate: true once every annotator_tile in the batch is 'completed'. */
  mergeReady: boolean;
  classes: Label[];
  groups: Group[];
  compounds: Compound[];
  images: CanvasImage[];
};

/** One pooled mark from the merge-annotations read — same shape as CanvasAnnotation,
 * just fetched cross-annotator (see MergeCanvasScreen.tsx). */
export type MergeAnnotations = { annotations: CanvasAnnotation[] };

/** MERGE Phase 2a: a merger's candidate-object row (the lesion-hypothesis identity — the
 * `<g data-testid="candidate-object">` hull is a FE display concern computed from the
 * live members' geometry, not persisted here). See webapp/projects.py list/create. */
export type CandidateObject = { id: string; imageId: string; memberIds: string[] };
export type CandidateObjects = { candidateObjects: CandidateObject[] };

/** MERGE Phase 2a: this merger's erasures (per-merger toggles that flag a pooled mark
 * as not-a-lesion — recoverable, survives reload). See webapp/projects.py list. */
export type Erasures = { erasedIds: string[] };

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

  /** MERGE Phase 1: batch structure (images/tiles) with no per-annotator annotations —
   * MergeCanvasScreen pairs this with mergeAnnotations() for the pooled, blind read. */
  mergeBatch: (batchId: string) => jfetch<BatchCanvas>(`/api/batches/${batchId}`),

  /** MERGE Phase 1: every non-deleted annotation from every annotator, scoped to this
   * batch's tiles — the pooled read rendered one-colour/outline-only (blind). */
  mergeAnnotations: (batchId: string) =>
    jfetch<MergeAnnotations>(`/api/batches/${batchId}/merge-annotations`),

  /** Advance a merge-ready batch to status='merge'. Idempotent; 409 if not ready. */
  enterMerge: (batchId: string) =>
    jfetch<{ ok: boolean; status: string }>(`/api/batches/${batchId}/enter-merge`, jbody('POST', {})),

  // ── MERGE Phase 2a: candidate-object + erasure endpoints (see webapp/projects.py) ──
  listCandidateObjects: (batchId: string, merger: string) =>
    jfetch<CandidateObjects>(
      `/api/batches/${batchId}/candidate-objects?merger=${encodeURIComponent(merger)}`),
  createCandidateObject: (batchId: string, body: {
    imageId: string; brushPath?: number[][]; brushWidth?: number; memberIds?: string[];
  }) => jfetch<CandidateObject>(
    `/api/batches/${batchId}/candidate-objects`, jbody('POST', body)),
  patchCandidateObject: (coid: string, body: { addIds?: string[]; removeIds?: string[] }) =>
    jfetch<CandidateObject>(`/api/candidate-objects/${coid}`, jbody('PATCH', body)),
  dissolveCandidateObject: (coid: string) =>
    jfetch<null>(`/api/candidate-objects/${coid}`, { method: 'DELETE' }),

  listErasures: (batchId: string, merger: string) =>
    jfetch<Erasures>(`/api/batches/${batchId}/erasures?merger=${encodeURIComponent(merger)}`),
  createErasure: (batchId: string, annotationId: string) =>
    jfetch<{ ok: boolean; annotationId: string }>(
      `/api/batches/${batchId}/erasures`, jbody('POST', { annotationId })),
  deleteErasure: (batchId: string, annotationId: string) =>
    jfetch<null>(
      `/api/batches/${batchId}/erasures/${encodeURIComponent(annotationId)}`, { method: 'DELETE' }),

  createAnnotation: (projectId: string, body: {
    imageId: string; annotator: string; kind: string; points: number[][];
    passNo?: number; label?: string; viewport?: Rect; hsvHist?: unknown;
    strokeWidth?: number; outline?: number[][]; tool?: string;
  }) => jfetch<CreateAnnotationResult>(`/api/projects/${projectId}/annotations`, jbody('POST', body)),
  // `label: string | null` (not `?string`) so a relabel-undo/redo of a lesion whose
  // prior label was null still sends the `label` key — JSON.stringify drops `undefined`
  // properties but keeps explicit `null`, and the label-only PATCH branch (webapp/
  // projects.py) requires the key present (see canvasHistory.ts `relabel` undo/redo).
  updateAnnotation: (annotationId: string, body: { points?: number[][]; label?: string | null }) =>
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

  ...strokeEditApi,

  setTileState: (annotatorTileId: string, state: 'assigned' | 'completed' | 'dirty') =>
    jfetch<{ ok: boolean; state: string }>(`/api/annotator-tiles/${annotatorTileId}`, jbody('PATCH', { state })),

  /** Batch-insert viewport (pan/zoom) telemetry samples — see viewportTelemetry.ts.
   * Best-effort by design: callers swallow rejections, never surface them to the user. */
  postViewportEvents: (projectId: string, body: { imageId: string; events: ViewportSample[] }) =>
    jfetch<{ ok: boolean; count: number }>(`/api/projects/${projectId}/viewport-events`, jbody('POST', body)),

  /** Admin-only: fetch the recorded viewport telemetry rows for an image so the client
   *  can compute the viewport-attention heatmap overlay. Rows are ordered by
   *  (user_id, client_ts) for per-user consecutive-pair dwell. Optional userId filter. */
  listViewportEvents: (projectId: string, imageId: string, userId?: string) =>
    jfetch<{ events: ViewportEventRow[] }>(
      `/api/projects/${projectId}/images/${imageId}/viewport-events`
      + (userId ? `?user_id=${encodeURIComponent(userId)}` : '')),
};

/** One captured canvas viewport sample — wire shape for postViewportEvents. See
 * viewportTelemetry.ts for how samples are gathered/batched. */
export type ViewportSample = {
  clientTs: string; x: number; y: number; w: number; h: number;
  cssW: number; cssH: number; dpr: number;
};

/** One recorded viewport telemetry row, as returned by the admin-only
 * GET .../viewport-events endpoint (see listViewportEvents). */
export type ViewportEventRow = {
  id: number;
  userId: string;
  clientTs: string;
  receivedAt: string;
  x: number; y: number; w: number; h: number;
  cssW: number; cssH: number; dpr: number;
};
