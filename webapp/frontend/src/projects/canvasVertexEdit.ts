/**
 * canvasVertexEdit — pure geometry behind the polyline/brush vertex-editing UX
 * (a11y #40 v1b). Domain-agnostic, DOM-free, unit-testable — the interactive
 * overlay + wire-up live in VertexHandles.tsx / canvasPersistence.ts / canvasHistory.ts.
 *
 * When a stroke MASK is selected (Select tool), the canvas draws a draggable dot at
 * each of its member strokes' stored input points (polyline = clicked vertices;
 * brush = the freehand mouse trail — editable too, expected to look rough). Grabbing
 * a handle and dragging moves that one vertex; on drop the FE PATCHes /strokes/<id>
 * with the moved points + a freshly-recomputed outline.
 */
import type { CanvasAnnotation } from './canvasApi';

/** Editable member stroke as shipped on `CanvasAnnotation.strokes`. */
export type EditableStroke = {
  id: string;
  tool: string;
  points: number[][];
  strokeWidth: number;
  /** Vertex-snapping (t50): canonical vertex id per point, when the stroke carries one
   *  (index-aligned with `points`). Used by `sharedVertexId` to detect a SHARED (snapped)
   *  vertex — one referenced by >= 2 strokes across the loaded annotations. */
  vertexIds?: string[];
};

/** Identifies which vertex a grab lands on. */
export type VertexHit = { strokeId: string; index: number };

/**
 * Image-space handle radius so the dot stays a CONSTANT screen size at any zoom.
 * `scale` = image-space units per screen pixel (bigger when zoomed OUT). A fixed
 * image-space size would vanish for a 1-px brush; scaling by the current CTM keeps
 * it grabbable. Never collapses to 0 — even at a bogus/zero scale we return a small
 * positive floor so the handle is always hittable.
 */
export function handleRadiusImg(screenPx: number, scale: number): number {
  const r = screenPx * scale;
  return r > 1e-3 ? r : 1e-3;
}

/**
 * Nearest-vertex hit test: `{strokeId, index}` of the vertex within `radiusImg` of
 * the image-space point (px,py), or null when nothing is in range. Scans strokes
 * TOPMOST-first (later in `strokes` paints on top) with a strict-less comparison,
 * so an exact tie among vertices at equal distance goes to the topmost stroke.
 */
export function hitHandle(
  strokes: EditableStroke[], px: number, py: number, radiusImg: number,
): VertexHit | null {
  let bestSq = radiusImg * radiusImg;
  let best: VertexHit | null = null;
  for (let s = strokes.length - 1; s >= 0; s--) {
    const stroke = strokes[s];
    for (let i = 0; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i];
      const dsq = (x - px) ** 2 + (y - py) ** 2;
      if (dsq < bestSq || (best === null && dsq <= bestSq)) {
        bestSq = dsq;
        best = { strokeId: stroke.id, index: i };
      }
    }
  }
  return best;
}

/**
 * Return a NEW points array with only `points[index]` replaced by [nx, ny]. Non-
 * mutating so callers can safely use the result for a live-preview memo without
 * touching the stored geometry until the drag commits.
 */
export function moveVertex(
  points: number[][], index: number, nx: number, ny: number,
): number[][] {
  return points.map((p, i) => (i === index ? [nx, ny] : p));
}

/**
 * t66: edit-time vertex MERGE. If the dragged vertex `index` is dropped within
 * `radiusImg` of an ADJACENT vertex (index-1 or index+1) in the SAME stroke, the two
 * collapse into one — return a NEW points array with the dragged vertex REMOVED (the
 * neighbour stays put). Returns null for an ordinary move (no adjacent vertex in range)
 * or when the stroke has ≤ 1 point (nothing to merge into). Only ADJACENT vertices merge:
 * dropping onto a non-adjacent vertex of the same polyline is a crossing, not a duplicate.
 */
export function collapseOnAdjacent(
  points: number[][], index: number, nx: number, ny: number, radiusImg: number,
): number[][] | null {
  if (points.length <= 1) return null;
  const rSq = radiusImg * radiusImg;
  const near = (j: number): boolean => {
    if (j < 0 || j >= points.length || j === index) return false;
    const [x, y] = points[j];
    return (x - nx) ** 2 + (y - ny) ** 2 <= rSq;
  };
  if (near(index - 1) || near(index + 1)) return points.filter((_, i) => i !== index);
  return null;
}

/** t65: scale every point's per-vertex size by `factor` (a relative stroke resize). Points
 *  without a stored size fall back to the stroke's `width`; never shrinks below 1px. */
export function scaleStrokeSizes(points: number[][], factor: number, width: number): number[][] {
  return points.map((p) => [p[0], p[1], Math.max(1, (p[2] ?? width) * factor)]);
}

/** t65: set every point's size to `size` (an absolute stroke resize; ≥1px). */
export function setStrokeSizes(points: number[][], size: number): number[][] {
  const s = Math.max(1, size);
  return points.map((p) => [p[0], p[1], s]);
}

/** Convenience: the editable strokes from a selected annotation, or []. */
export function annStrokes(ann: CanvasAnnotation | undefined): EditableStroke[] {
  return ann?.strokes ?? [];
}

/** Minimal shape `sharedVertexId` needs — every loaded annotation's member strokes. */
type VertexScanAnnotation = { strokes?: { id: string; vertexIds?: string[] }[] };

/**
 * t50 phase 3b: the vertex id at (strokeId, index) IFF it's SHARED — referenced by >= 2
 * strokes across ALL `annotations` (counting every occurrence of that id over every
 * annotation's `strokes[].vertexIds`). Returns null for an unshared/unknown vertex, an
 * unknown stroke, or an out-of-range index — drives whether a handle drag routes to the
 * move op (shared) or the per-stroke edit (unshared).
 */
export function sharedVertexId(
  annotations: VertexScanAnnotation[], strokeId: string, index: number,
): string | null {
  let target: string | undefined;
  for (const ann of annotations) {
    for (const s of ann.strokes ?? []) {
      if (s.id === strokeId) { target = s.vertexIds?.[index]; break; }
    }
    if (target !== undefined) break;
  }
  if (!target) return null;
  let count = 0;
  for (const ann of annotations) {
    for (const s of ann.strokes ?? []) {
      count += (s.vertexIds ?? []).filter((v) => v === target).length;
    }
  }
  return count >= 2 ? target : null;
}
