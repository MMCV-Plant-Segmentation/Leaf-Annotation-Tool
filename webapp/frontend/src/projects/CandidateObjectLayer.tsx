/**
 * MERGE Phase 2a: renders every candidate object (CO) for the current image as a soft,
 * brush-stroke-styled hull over its member marks. The CO's IDENTITY server-side is only
 * its member ids (see webapp/projects.py `_co_out`); the hull shape is a FE display
 * concern, computed here from the members' pooled geometry — the "border is still
 * completely computed; we just draw something that looks like a brush stroke along the
 * convex hull" (per the merge 2a spec). Each rendered CO element carries
 * `data-testid="candidate-object"` for e2e/interaction. The layer is `pointer-events:
 * none` so a click on an underlying mark (eraser/select tools) is never intercepted by
 * a CO hull — CO selection is handled via image-space hit-testing in MergeCanvasScreen.
 */
import { type Component, For, Show } from 'solid-js';
import type { CandidateObject, CanvasAnnotation } from './api';

// CO paint — data-viz colour so it lives inline (per FE convention). Amber contrasts
// with the blind pooled-mark cyan (#0ea5e9) without stealing the eye.
const CO_STROKE = '#f59e0b';
const CO_FILL = 'rgba(245, 158, 11, 0.10)';
// Stroke width in image coords. `vector-effect="non-scaling-stroke"` keeps this crisp
// while zoomed, but a plain image-space width is a good default for the "brush-along-
// the-hull" feel (a hairline polygon would look sharp/technical, which the spec rules out).
const CO_STROKE_WIDTH = 12;

/** Andrew's monotone chain — pure convex hull of a point cloud in image coords.
 * Returns the hull vertices in CCW order (SVG's y-down doesn't matter for the polygon
 * — winding only affects fill-rule, and we use the default even-odd behavior). */
function convexHull(pts: number[][]): number[][] {
  if (pts.length <= 1) return pts.slice();
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: number[][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Collect a member annotation's representative points for the hull. kind='stroke'
 * uses its stored exterior ring (the fused mask silhouette); other kinds use `points`
 * (fallback to a single point for kind='point'). */
function annotationPoints(ann: CanvasAnnotation): number[][] {
  if (ann.kind === 'stroke') return ann.rings[0] ?? [];
  if (ann.kind === 'point') return ann.points.length ? [ann.points[0]] : [];
  return ann.points;
}

/** Union of the hulls' interior polygons — used by MergeCanvasScreen's image-space hit
 * test to detect a click on a CO (dissolve). Kept here so both renderer and hit-test
 * share ONE convex-hull definition. */
export function coHullPoints(co: CandidateObject, annotations: CanvasAnnotation[]): number[][] {
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const all: number[][] = [];
  for (const mid of co.memberIds) {
    const a = byId.get(mid); if (!a) continue;
    for (const p of annotationPoints(a)) all.push(p);
  }
  return convexHull(all);
}

function hullToPath(hull: number[][]): string {
  if (hull.length < 2) return '';
  const [h0, ...rest] = hull;
  return ['M', h0[0], h0[1], ...rest.flatMap(([x, y]) => ['L', x, y]), 'Z'].join(' ');
}

/** Renders every CO for the current image. Every CO gets a `<g data-testid=
 * "candidate-object">` even if its members haven't loaded yet or have no geometry —
 * the CO's IDENTITY is server-owned (its id), so the FE always presents it. Elements
 * are `pointer-events: none` so they never block eraser/select clicks on underlying
 * pooled marks (CO selection is via MergeCanvasScreen's image-space hit-test). */
export const CandidateObjectLayer: Component<{
  cos: CandidateObject[]; annotations: CanvasAnnotation[];
}> = (props) => (
  <For each={props.cos}>
    {(co) => {
      const hull = () => coHullPoints(co, props.annotations);
      const path = () => hullToPath(hull());
      return (
        <g data-testid="candidate-object" data-co-id={co.id}
           style={{ 'pointer-events': 'none' }}>
          <Show when={hull().length >= 2}>
            <path d={path()} fill={CO_FILL} stroke={CO_STROKE} stroke-width={CO_STROKE_WIDTH}
              stroke-linejoin="round" stroke-linecap="round"
              stroke-opacity="0.75"
              vector-effect="non-scaling-stroke" />
          </Show>
        </g>
      );
    }}
  </For>
);

export default CandidateObjectLayer;
