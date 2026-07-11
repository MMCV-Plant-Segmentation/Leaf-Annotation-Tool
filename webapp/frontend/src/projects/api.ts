// API client + types for the annotator project pipeline.
// Mirrors webapp/projects.py. Kept thin so the backend stays the single source of truth.

/** A per-project label (Option A taxonomy): flat list, no hierarchy/sharing. */
export type Label = { id: string; name: string; color: string; order: number };

export type ProjectSummary = {
  id: string;
  name: string;
  tile_size_px: number;
  black_threshold: number;
  classes: Label[];
  groups: Group[];
  compounds: Compound[];
  tiling_confirmed: boolean;
  created_by: string | null;
  created_at: string;
  imageCount: number;
  batchCount: number;
  annotatorCount: number;
};

/** A registered user for roster autocomplete. */
export type RosterUser = { id: number; username: string };

export type Annotator = { id: string; user_id: number | null; byline: string };

export type ProjectImage = {
  id: string;
  image_hash: string;
  image_ext: string;
  source_name: string | null;
  source_path: string | null;
  width: number;
  height: number;
  origin_y: number;
  leaf_x: number; leaf_y: number; leaf_w: number; leaf_h: number;
};

export type Batch = {
  id: string;
  seq: number;
  size: number;
  status: string;
  tileCount: number;
  /** MERGE Phase 1 gate: true once every annotator_tile in the batch is 'completed'. */
  mergeReady: boolean;
};

export type Progress = {
  annotator: string;
  tilesCompleted: number;
  tilesTotal: number;
  annotationCount: number;
  vertexCount: number;
};

export type ProjectDetail = ProjectSummary & {
  annotators: Annotator[];
  images: ProjectImage[];
  batches: Batch[];
  progress: Progress[];
};

export type Rect = { x: number; y: number; w: number; h: number };

export type TilePreview = {
  imageWidth: number;
  imageHeight: number;
  leafBbox: Rect;
  originY: number;
  tileSize: number;
  tiles: Rect[];
};

import { jbody, jfetch } from './httpJson';
import type { Group, Compound } from './taxonomy';

// Canvas annotation types + their API methods live in their own module (keeps this file
// ≤200 lines) — re-exported here so every existing `projectsApi.foo(...)` / `import type
// {...} from './api'` call site keeps working unchanged.
export type {
  CanvasTile, TileStateUpdate, CanvasAnnotation, CanvasImage, BatchCanvas,
  ConsumedGroup, CreateAnnotationResult, MergeAnnotations,
  CandidateObject, CandidateObjects, Erasures,
  CanvasStroke, StrokeEditBefore, StrokeEditGroup,
} from './canvasApi';
import { canvasApi } from './canvasApi';

// Streaming import lives in its own module to keep this file ≤200 lines; re-export so
// callers (and the unit tests) keep a single import surface.
export { streamImport, streamUpload, type ImportEvent } from './importStream';

export const projectsApi = {
  list: () => jfetch<ProjectSummary[]>('/api/projects'),
  get: (id: string) => jfetch<ProjectDetail>(`/api/projects/${id}`),
  create: (body: { name: string }) =>
    jfetch<ProjectSummary>('/api/projects', jbody('POST', body)),
  update: (id: string, body: Partial<{ name: string; black_threshold: number; classes: Label[]; groups: Group[]; compounds: Compound[]; tiling_confirmed: boolean }>) =>
    jfetch<ProjectSummary>(`/api/projects/${id}`, jbody('PATCH', body)),
  updateTileSize: (id: string, tileSizePx: number) =>
    jfetch<ProjectSummary>(`/api/projects/${id}`, jbody('PATCH', { tile_size_px: tileSizePx })),
  remove: (id: string) => jfetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  /** Roster autocomplete: returns [{id, username}] — non-admin, login_required. */
  listUsers: (q?: string) =>
    jfetch<RosterUser[]>(`/api/users/members${q ? `?q=${encodeURIComponent(q)}` : ''}`),

  /** Add a registered user to the project roster by their user_id. */
  addAnnotator: (id: string, userId: number) =>
    jfetch<{ ok: boolean; byline: string; user_id: number }>(
      `/api/projects/${id}/annotators`, jbody('POST', { user_id: userId })),
  removeAnnotator: (id: string, annotatorId: string) =>
    jfetch<{ ok: boolean }>(`/api/projects/${id}/annotators/${annotatorId}`, { method: 'DELETE' }),

  importImages: (id: string, path: string) =>
    jfetch<{ imported: number; skipped: number; errors: { file: string; error: string }[] }>(
      `/api/projects/${id}/images/import`, jbody('POST', { path })),
  removeImage: (id: string, imageId: string) =>
    jfetch<{ ok: boolean }>(`/api/projects/${id}/images/${imageId}`, { method: 'DELETE' }),

  previewTiles: (id: string, imageId: string, q: { tile_size?: number; black_threshold?: number; origin_y?: number }) => {
    const p = new URLSearchParams();
    if (q.tile_size != null) p.set('tile_size', String(q.tile_size));
    if (q.black_threshold != null) p.set('black_threshold', String(q.black_threshold));
    if (q.origin_y != null) p.set('origin_y', String(q.origin_y));
    return jfetch<TilePreview>(`/api/projects/${id}/images/${imageId}/tiles/preview?${p}`);
  },

  createBatch: (id: string, size: number) =>
    jfetch<Batch & { rosterSize: number }>(`/api/projects/${id}/batches`, jbody('POST', { size })),

  ...canvasApi,
};

export const imageUrls = {
  overview: (imageId: string) => `/api/projects/images/${imageId}/overview`,
  crop: (imageId: string, r: Rect) =>
    `/api/projects/images/${imageId}/crop?x=${r.x}&y=${r.y}&w=${r.w}&h=${r.h}`,
};
