import KDBush from 'kdbush';

/**
 * Draw-time vertex snapping — PHASE 2b (t50). Detection module: flattens every
 * (point, vertexId) pair across every stroke on the image into a k-d tree so a
 * polyline click can snap onto the nearest EXISTING vertex within a radius and
 * reference its stable id (phase-2a persistence — a shared/locked vertex). A
 * fixed grid can't serve this: the snap radius is a QUERY argument (varies with
 * the current brush size at click time), which is exactly what `kdbush`'s
 * `within(x, y, r)` gives us over a static built index.
 *
 * Kept pure/framework-free so it's usable from both the interaction layer and
 * unit tests without any Solid/DOM machinery.
 */
export interface VertexIndex {
  index: KDBush | null;
  xs: number[];
  ys: number[];
  ids: string[];
  /** Per-vertex RADIUS (image-space) = its stored point size (p[2], a diameter) / 2.
   * t80: a click snaps if it's within max(brushRadius, thisVertexRadius) — so a fat
   * existing point stays snappable from far even under a tiny brush. 0 when the point
   * carries no size (legacy [x,y] pairs) — then only the brush radius applies. */
  radii: number[];
  /** The largest per-vertex radius in the index — the query's upper bound (see resolveSnap). */
  maxRadius: number;
}

/** Build a queryable index over every (point, vertexId) pair on the image. Strokes
 * lacking `vertexIds` (not yet vertex-normalized server-side) contribute nothing —
 * we can't reference an id we don't have. */
export function buildVertexIndex(
  strokes: { points: number[][]; vertexIds?: string[] }[],
): VertexIndex {
  const xs: number[] = [];
  const ys: number[] = [];
  const ids: string[] = [];
  const radii: number[] = [];
  let maxRadius = 0;
  for (const s of strokes) {
    if (!s.vertexIds) continue;
    s.points.forEach((p, i) => {
      const vid = s.vertexIds![i];
      if (vid == null) return;
      xs.push(p[0]);
      ys.push(p[1]);
      ids.push(vid);
      const r = (p[2] ?? 0) / 2;
      radii.push(r);
      if (r > maxRadius) maxRadius = r;
    });
  }
  let index: KDBush | null = null;
  if (xs.length) {
    index = new KDBush(xs.length);
    for (let i = 0; i < xs.length; i++) index.add(xs[i], ys[i]);
    index.finish();
  }
  return { index, xs, ys, ids, radii, maxRadius };
}

/** The NEAREST snappable vertex to (x, y), at its CANONICAL position + stable id, or
 * null when nothing is in range. t80: a vertex is snappable when the click is within
 * `max(brushRadiusImg, thatVertex'sRadius)` of it — so we query with the upper bound
 * `max(brushRadiusImg, idx.maxRadius)` (kdbush needs one radius), then keep only hits
 * that pass their OWN per-vertex threshold, and among those pick the nearest. */
export function resolveSnap(
  idx: VertexIndex, x: number, y: number, brushRadiusImg: number,
): { x: number; y: number; vertexId: string } | null {
  if (!idx.index) return null;
  const hits = idx.index.within(x, y, Math.max(brushRadiusImg, idx.maxRadius));
  let best = -1;
  let bestDist = Infinity;
  for (const i of hits) {
    const d = Math.hypot(idx.xs[i] - x, idx.ys[i] - y);
    if (d <= Math.max(brushRadiusImg, idx.radii[i]) && d < bestDist) { bestDist = d; best = i; }
  }
  if (best < 0) return null;
  return { x: idx.xs[best], y: idx.ys[best], vertexId: idx.ids[best] };
}
