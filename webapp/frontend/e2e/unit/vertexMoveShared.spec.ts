/**
 * Vertex snapping — PHASE 3b unit: dragging a SHARED vertex moves all referencing marks (t50).
 *
 * Christian, 2026-07-20: "moving one moves the other." Phase 3a added the backend vertex-move
 * (PATCH .../vertices/<id> → re-fuse every referencing annotation). This phase wires the vertex-edit
 * DRAG to it: when the grabbed handle's vertex is SHARED (referenced by >= 2 strokes across the loaded
 * annotations), the drop routes to the move op instead of the per-stroke edit — so every mark sharing
 * that vertex follows. A non-shared vertex keeps the existing single-stroke edit path.
 *
 * Contract:
 *   canvasVertexEdit.sharedVertexId(annotations, strokeId, index) -> vertexId | null
 *     — the vertex id at (strokeId, index) IFF it is referenced by >= 2 strokes across `annotations`
 *       (i.e. a snapped/locked vertex), else null. Drives the drop's route decision.
 *   createCanvasPersistence(...).moveSharedVertex(vertexId, before, after) -> Promise
 *     — before/after are {x,y}; sends the `moveVertex` op {vertexId, x:after.x, y:after.y}, applies
 *       the returned affected annotations (drop deletedAnnotationIds, add the re-fused `annotations`),
 *       and pushes a `vertexMove` history entry carrying before+after so undo/redo re-send the move.
 *
 * RED until sharedVertexId + moveSharedVertex exist.
 */
import { test, expect } from '@playwright/test';

test('sharedVertexId returns the id only when the vertex is referenced by >= 2 strokes', async () => {
  const { sharedVertexId } = await import('../../src/projects/canvasVertexEdit');
  const annotations = [
    { id: 'A', strokes: [{ id: 'sA', points: [[10, 10], [20, 20]], vertexIds: ['vShared', 'vA1'] }] },
    { id: 'B', strokes: [{ id: 'sB', points: [[10, 10], [30, 40]], vertexIds: ['vShared', 'vB1'] }] },
  ];
  // (sA, 0) -> vShared, referenced by sA AND sB -> shared
  expect(sharedVertexId(annotations as never, 'sA', 0)).toBe('vShared');
  // (sA, 1) -> vA1, only sA references it -> not shared
  expect(sharedVertexId(annotations as never, 'sA', 1)).toBeNull();
  // unknown stroke / out-of-range index -> null
  expect(sharedVertexId(annotations as never, 'nope', 0)).toBeNull();
  expect(sharedVertexId(annotations as never, 'sA', 9)).toBeNull();
});

test('moveSharedVertex sends the move op, applies the re-fused masks, and records undo', async () => {
  const { createCanvasPersistence } = await import('../../src/projects/canvasPersistence');

  const moveResult = {
    ok: true, vertexId: 'vShared', x: 99, y: 88,
    deletedAnnotationIds: ['A', 'B'], deletedGroups: [],
    annotations: [
      { id: 'A2', kind: 'stroke', label: 'la', strokes: [{ id: 'sA', vertexIds: ['vShared', 'vA1'] }], rings: [[[0, 0]]] },
      { id: 'B2', kind: 'stroke', label: 'lb', strokes: [{ id: 'sB', vertexIds: ['vShared', 'vB1'] }], rings: [[[1, 1]]] },
    ],
    createdGroups: [], tileStates: [],
  };
  const sent: { op: string; body: unknown }[] = [];
  const pushed: unknown[] = [];
  let selected: string | undefined;
  let img = {
    imageId: 'img1', width: 100, height: 100, tiles: [],
    annotations: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
  };
  const opts = {
    image: () => img,
    getProjectId: () => 'proj1',
    annotator: () => 'alice',
    selClass: () => 'la',
    vb: () => ({ x: 0, y: 0, w: 100, h: 100 }),
    updateImg: (fn: (im: typeof img) => typeof img) => { img = fn(img); },
    history: { push: (e: unknown) => pushed.push(e) },
    socket: {
      enqueue: async (task: (s: (op: string, body: unknown) => Promise<unknown>) => unknown) =>
        task(async (op: string, body: unknown) => { sent.push({ op, body }); return { ok: true, result: moveResult }; }),
    },
    setSelectedId: (id: string) => { selected = id; },
  };

  const { moveSharedVertex } = createCanvasPersistence(opts as never);
  await moveSharedVertex('vShared', { x: 10, y: 10 }, { x: 99, y: 88 });

  // sent the moveVertex op with the vertex id + new (after) position
  expect(sent).toHaveLength(1);
  expect(sent[0].op).toBe('moveVertex');
  expect(sent[0].body).toMatchObject({ vertexId: 'vShared', x: 99, y: 88 });
  // applied the re-fused masks: A/B replaced by A2/B2, C untouched
  expect(img.annotations.map((a) => a.id).sort()).toEqual(['A2', 'B2', 'C']);
  // t78: the move re-mints the mask, so the selection must migrate onto the re-fused mask
  // that still carries the moved vertex (else the handles/highlight stick on the dead id).
  expect(selected).toBe('A2');
  // recorded an undoable vertexMove carrying before+after (undo moves it back to before)
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toMatchObject({
    kind: 'vertexMove', vertexId: 'vShared', before: { x: 10, y: 10 }, after: { x: 99, y: 88 },
  });
});
