/**
 * Helpers for stroke→lesion lookup on the client.
 *
 * All lesion geometry lives on the server (Shapely); the client only stores the grouping
 * (memberIds arrays) returned by mutating endpoints. These helpers query that grouping.
 */

import type { CanvasAnnotation, CanvasLesion } from './api';

/**
 * Return all CanvasAnnotation objects that belong to the same lesion as `strokeId`.
 * If the stroke is not in any multi-member lesion it is treated as its own lesion,
 * returning just itself (by id lookup in annotations).
 */
export function lesionAnnsFor(
  lesions: CanvasLesion[],
  strokeId: string,
  annotations: CanvasAnnotation[],
): CanvasAnnotation[] {
  const lesion = lesions.find((l) => l.memberIds.includes(strokeId));
  const ids = lesion ? lesion.memberIds : [strokeId];
  return annotations.filter((a) => ids.includes(a.id));
}
