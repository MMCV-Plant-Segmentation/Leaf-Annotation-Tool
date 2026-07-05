// Lesion hit-testing for the selection tool. Pure geometry — no DOM — so it is
// unit-testable and stays out of CanvasScreen (keeping that file ≤200 lines).
//
// A click "hits" a lesion when the image-space point falls inside the lesion's
// rendered geometry:
//   - kind 'stroke' (fused mask): point-in-polygon against the first (exterior) ring;
//     the server stores drop_holes(union(...)) so the exterior ring is the lesion's
//     silhouette. (Holes would only matter for erasing; a click in a hole is not on
//     the lesion, but legacy rings are hole-less, so we keep it simple + robust.)
//   - kind 'polygon': point-in-polygon against its points.
//   - kind 'point': within a small radius of the marker.
//   - kind 'line': within a small distance of any segment.
//
// Annotations are tested topmost-first (the canvas renders them in array order, so a
// later annotation paints over an earlier one — the visually-topmost lesion wins).
import type { CanvasAnnotation } from './api';

// Ray-casting point-in-polygon. `poly` is a flat [x,y] point array.
export function pointInPolygon(px: number, py: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Squared distance from point P to segment AB — avoids a sqrt per segment.
function distSqToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-12;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

// Pixel tolerance for clicking points/lines (image-space). Generous enough that a
// thin marker is easy to grab, tight enough not to grab a neighbour.
const HIT_TOLERANCE_PX = 8;

/** Does an image-space click at (px,py) land on this annotation? */
export function annotationHit(ann: CanvasAnnotation, px: number, py: number): boolean {
  if (ann.kind === 'stroke') {
    if (!ann.rings.length) return false;
    // Exterior ring is rings[0]; holes (if any) would subtract but legacy rings are hole-less.
    return pointInPolygon(px, py, ann.rings[0]);
  }
  if (ann.kind === 'polygon') {
    return ann.points.length >= 3 && pointInPolygon(px, py, ann.points);
  }
  if (ann.kind === 'point') {
    const [cx, cy] = ann.points[0] ?? [NaN, NaN];
    return (px - cx) ** 2 + (py - cy) ** 2 <= HIT_TOLERANCE_PX ** 2;
  }
  if (ann.kind === 'line') {
    for (let i = 0; i + 1 < ann.points.length; i++) {
      const [ax, ay] = ann.points[i];
      const [bx, by] = ann.points[i + 1];
      if (distSqToSeg(px, py, ax, ay, bx, by) <= HIT_TOLERANCE_PX ** 2) return true;
    }
    return false;
  }
  return false;
}

/**
 * Return the id of the topmost annotation hit by a click at (px,py), or null when
 * the click lands on empty space. `annotations` is the rendered (visible) list in
 * paint order; we walk it back-to-front so the visually-topmost lesion wins.
 */
export function hitTestAnnotation(annotations: CanvasAnnotation[], px: number, py: number): string | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (annotationHit(annotations[i], px, py)) return annotations[i].id;
  }
  return null;
}
