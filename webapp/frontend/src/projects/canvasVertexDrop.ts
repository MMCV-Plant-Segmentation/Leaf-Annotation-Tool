import { buildVertexIndex, type VertexIndex } from './canvasSnap';

/**
 * Edit-time vertex SNAPPING (Christian 2026-10-11): a vertex handle dropped onto another
 * existing vertex snaps onto it and LOCKS to it (the edit references that vertex's id), the
 * same way a draw-time polyline click does (canvasSnap.ts). Pure + DOM-free.
 */

/** Minimal shape needed: every loaded annotation's member strokes, with their points. */
export type SnapScanAnnotation = {
  strokes?: { id: string; points?: number[][]; vertexIds?: string[] }[];
};

/** The vertex id at (strokeId, index), or undefined when the stroke carries none. */
export function vertexIdAt(
  annotations: SnapScanAnnotation[], strokeId: string, index: number,
): string | undefined {
  for (const a of annotations) {
    const s = a.strokes?.find((st) => st.id === strokeId);
    if (s) return s.vertexIds?.[index];
  }
  return undefined;
}

/** A snap index over every vertex on the image EXCEPT the dragged one (by id, so every
 *  occurrence of it goes — it can't snap onto itself). Built once per drag. */
export function dragSnapIndex(
  annotations: SnapScanAnnotation[], strokeId: string, index: number,
): VertexIndex {
  const self = vertexIdAt(annotations, strokeId, index);
  const strokes = annotations.flatMap((a) => a.strokes ?? []).map((s) => {
    const keep = (s.vertexIds ?? []).map((v) => v !== self);
    return { points: (s.points ?? []).filter((_, i) => keep[i]),
      vertexIds: s.vertexIds?.filter((_, i) => keep[i]) };
  });
  return buildVertexIndex(strokes);
}

