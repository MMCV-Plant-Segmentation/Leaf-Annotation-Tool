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
 *   resolveSnap(index, x, y, radiusImg) -> {x,y,vertexId} | null
 *     — the NEAREST indexed vertex within radiusImg of (x,y), returning its CANONICAL position +
 *       stable id, or null when nothing is in range. radiusImg is a query arg (varies per click).
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

test('empty index / strokes without vertexIds → no snap', async () => {
  const { buildVertexIndex, resolveSnap } = await import('../../src/projects/canvasSnap');
  expect(resolveSnap(buildVertexIndex([]), 0, 0, 10)).toBeNull();
  // a stroke missing vertexIds contributes nothing (can't reference an unknown id)
  const idx = buildVertexIndex([{ points: [[10, 10, 5]] }]);
  expect(resolveSnap(idx, 10, 10, 10)).toBeNull();
});
