/**
 * Vertex snapping — PHASE 2b unit: the snap-detection module (t50).
 *
 * Christian, 2026-07-20. Draw-time snapping snaps a new polyline vertex onto the nearest EXISTING
 * vertex (across ALL annotations on the image) within a radius, so it references that vertex's stable
 * id (phase-2a persistence → a shared/locked vertex). Detection uses a k-d tree (`kdbush`) so the
 * snap radius is a QUERY argument — a fixed grid can't handle the per-vertex/ per-session varying
 * brush (hence snap) radius. This spec pins the pure module the interaction calls.
 *
 * Contract (webapp/frontend/src/projects/canvasSnap.ts, to be created):
 *   buildVertexIndex(strokes: {points:number[][]; vertexIds?:string[]}[]) -> VertexIndex
 *     — flattens every (point, vertexId) pair on the image into a queryable index.
 *   resolveSnap(index, x, y, brushRadiusImg) -> {x,y,vertexId} | null
 *     — the NEAREST snappable vertex to (x,y): snappable = within max(brushRadiusImg, vertexRadius)
 *       (t80). Returns its CANONICAL position + stable id, or null when nothing is in range.
 *       brushRadiusImg is a query arg (varies per click); vertexRadius = point size (p[2]) / 2.
 *
 * RED until canvasSnap.ts exists.
 */
import { test, expect } from '@playwright/test';

test('resolveSnap returns the nearest vertex within radius, its canonical pos + id', async () => {
  const { buildVertexIndex, resolveSnap } = await import('../../src/projects/canvasSnap');
  const idx = buildVertexIndex([
    { points: [[10, 10, 5], [50, 50, 5]], vertexIds: ['vA', 'vB'] },
    { points: [[100, 20, 5]], vertexIds: ['vC'] },
  ]);
  // near vA → snaps onto vA's exact canonical position + id
  expect(resolveSnap(idx, 12, 9, 5)).toEqual({ x: 10, y: 10, vertexId: 'vA' });
  // far from everything → null
  expect(resolveSnap(idx, 500, 500, 5)).toBeNull();
  // radius is a QUERY ARG: a point ~8px from vB is out of range at r=5, in range at r=12
  expect(resolveSnap(idx, 50, 58, 5)).toBeNull();
  expect(resolveSnap(idx, 50, 58, 12)).toEqual({ x: 50, y: 50, vertexId: 'vB' });
  // among multiple in range, the NEAREST wins (vB at ~7 beats vA/vC)
  expect(resolveSnap(idx, 45, 45, 100)).toEqual({ x: 50, y: 50, vertexId: 'vB' });
});

test('t80: a fat vertex is snappable beyond the brush radius (max of the two radii)', async () => {
  const { buildVertexIndex, resolveSnap } = await import('../../src/projects/canvasSnap');
  // A giant point (size 40 → radius 20) and a tiny one (size 4 → radius 2).
  const idx = buildVertexIndex([
    { points: [[0, 0, 40]], vertexIds: ['big'] },
    { points: [[100, 0, 4]], vertexIds: ['small'] },
  ]);
  // Tiny brush (radius 3). A click 15px from the FAT point still snaps — its own radius (20)
  // dominates: max(3, 20) = 20 >= 15.
  expect(resolveSnap(idx, 15, 0, 3)).toEqual({ x: 0, y: 0, vertexId: 'big' });
  // The same 15px gap to the TINY point does NOT snap: max(3, 2) = 3 < 15.
  expect(resolveSnap(idx, 85, 0, 3)).toBeNull();
  // Right up close to the tiny point → snaps (well within the brush radius).
  expect(resolveSnap(idx, 102, 0, 3)).toEqual({ x: 100, y: 0, vertexId: 'small' });
});

test('empty index / strokes without vertexIds → no snap', async () => {
  const { buildVertexIndex, resolveSnap } = await import('../../src/projects/canvasSnap');
  expect(resolveSnap(buildVertexIndex([]), 0, 0, 10)).toBeNull();
  // a stroke missing vertexIds contributes nothing (can't reference an unknown id)
  const idx = buildVertexIndex([{ points: [[10, 10, 5]] }]);
  expect(resolveSnap(idx, 10, 10, 10)).toBeNull();
});
