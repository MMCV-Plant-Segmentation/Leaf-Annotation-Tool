/**
 * Vertex snapping — PHASE 2b unit: polylineClick snaps + threads the vertex ref (t50).
 *
 * Christian, 2026-07-20. When a polyline click lands within the snap radius of an existing vertex,
 * the placed vertex takes that vertex's CANONICAL position (so the two coincide exactly) and carries
 * its stable id as a per-point REFERENCE, threaded to the persistence layer as `vertexRefs` (phase 2a)
 * so the backend shares/locks the vertex. A click with nothing in range places the raw point with a
 * null ref (mint), exactly as before.
 *
 * Contract (webapp/frontend/src/projects/canvasPolyline.ts polylineClick, extended):
 *   opts gains: draftRefs/setDraftRefs (parallel to draft), snapIndex (VertexIndex accessor),
 *   snapRadiusImg (image-space brush-RADIUS accessor; resolveSnap maxes it with each vertex radius);
 *   polylineStep gains a 3rd arg: the parallel per-point refs array.
 *
 * RED until polylineClick snaps + threads refs (today it appends the raw [ix,iy,size] with no refs).
 */
import { test, expect } from '@playwright/test';

test('polylineClick snaps a near click onto the existing vertex and threads its id as a ref', async () => {
  const { polylineClick } = await import('../../src/projects/canvasPolyline');
  const { buildVertexIndex } = await import('../../src/projects/canvasSnap');
  const idx = buildVertexIndex([{ points: [[10, 10, 5]], vertexIds: ['vA'] }]);

  let draft: number[][] = [];
  let refs: (string | null)[] = [];
  const stepCalls: { points: number[][]; refs: (string | null)[] }[] = [];
  const o = {
    draft: () => draft, setDraft: (v: number[][]) => { draft = v; },
    draftRefs: () => refs, setDraftRefs: (v: (string | null)[]) => { refs = v; },
    brushSize: () => 8,
    snapIndex: () => idx,
    snapRadiusImg: () => 6,
    polylineStep: (points: number[][], _sw: number, r: (string | null)[]) =>
      stepCalls.push({ points, refs: r }),
  };

  // click near vA (12,9): snaps onto vA's canonical (10,10), keeps its own brush size, ref = 'vA'
  polylineClick(12, 9, o as never);
  expect(draft[0]).toEqual([10, 10, 8]);
  expect(refs[0]).toBe('vA');
  expect(stepCalls[0].refs).toEqual(['vA']);

  // click far (200,200): raw point, null ref (mint)
  polylineClick(200, 200, o as never);
  expect(draft[1]).toEqual([200, 200, 8]);
  expect(refs[1]).toBeNull();
  expect(stepCalls[1].refs).toEqual(['vA', null]);
});
