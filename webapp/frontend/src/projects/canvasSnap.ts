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
  for (const s of strokes) {
    if (!s.vertexIds) continue;
    s.points.forEach((p, i) => {
      const vid = s.vertexIds![i];
      if (vid == null) return;
      xs.push(p[0]);
      ys.push(p[1]);
      ids.push(vid);
    });
  }
  let index: KDBush | null = null;
  if (xs.length) {
    index = new KDBush(xs.length);
    for (let i = 0; i < xs.length; i++) index.add(xs[i], ys[i]);
    index.finish();
  }
  return { index, xs, ys, ids };
}

/** The NEAREST indexed vertex within `radiusImg` of (x, y), at its CANONICAL
 * position + stable id — or null when nothing is in range (or the index is empty). */
export function resolveSnap(
  idx: VertexIndex, x: number, y: number, radiusImg: number,
): { x: number; y: number; vertexId: string } | null {
  if (!idx.index) return null;
  const hits = idx.index.within(x, y, radiusImg);
  if (!hits.length) return null;
  let best = hits[0];
  let bestDist = Infinity;
  for (const i of hits) {
    const d = Math.hypot(idx.xs[i] - x, idx.ys[i] - y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return { x: idx.xs[best], y: idx.ys[best], vertexId: idx.ids[best] };
}
