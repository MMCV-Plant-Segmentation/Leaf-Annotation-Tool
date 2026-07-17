/**
 * P-3 regression (2026-07-17 testing): a vertex edit DELETES the selected mask and recreates it
 * under a NEW annotation id. `editStroke` must MIGRATE the selection onto the recreated mask —
 * otherwise the selection sticks on the deleted id, the highlight/handles can't resolve it, and
 * the canvas doesn't re-render until a reload (the exact bug Christian hit: FE frozen, selection
 * stuck, reload fixes it). This unit-tests the wiring deterministically, with no drag interaction.
 */
import { test, expect } from '@playwright/test';

type Created = { id: string; kind: string; strokes?: { id: string }[]; rings?: unknown };

function makeOpts(editResult: unknown, spy: { selected?: string }) {
  const send = async () => ({ ok: true, result: editResult });
  return {
    image: () => ({ imageId: 'img1', width: 100, height: 100, annotations: [{ id: 'old' }], tiles: [] }),
    getProjectId: () => 'proj1',
    annotator: () => 'alice',
    selClass: () => 'lesion',
    vb: () => ({ x: 0, y: 0, w: 100, h: 100 }),
    updateImg: () => {},
    history: { push: () => {} },
    socket: { enqueue: async (task: (s: typeof send) => unknown) => task(send) },
    setSelectedId: (id: string) => { spy.selected = id; },
  };
}

test('editStroke migrates the selection onto the recreated mask that owns the edited stroke', async () => {
  const { createCanvasPersistence } = await import('../../src/projects/canvasPersistence');
  const editResult = {
    strokeId: 's1', before: {}, deletedAnnotationIds: ['old'], deletedGroups: [],
    created: [
      { id: 'other', kind: 'stroke', strokes: [{ id: 'sX' }], rings: [] },
      { id: 'new', kind: 'stroke', strokes: [{ id: 's1' }], rings: [] },
    ],
    createdGroups: [], tileStates: [],
  };
  const spy: { selected?: string } = {};
  const { editStroke } = createCanvasPersistence(makeOpts(editResult, spy) as never);
  const created = await editStroke('s1', 'polyline', [[0, 0], [1, 1]], 4) as Created[];
  expect(spy.selected).toBe('new');                      // the mask that contains edited stroke s1
  expect(created.map((a) => a.id)).toEqual(['other', 'new']);
});

test('editStroke falls back to the first created mask when the edited stroke id is not found', async () => {
  const { createCanvasPersistence } = await import('../../src/projects/canvasPersistence');
  const editResult = {
    strokeId: 's1', before: {}, deletedAnnotationIds: ['old'], deletedGroups: [],
    created: [{ id: 'first', kind: 'stroke', strokes: [{ id: 'sZ' }], rings: [] }],
    createdGroups: [], tileStates: [],
  };
  const spy: { selected?: string } = {};
  const { editStroke } = createCanvasPersistence(makeOpts(editResult, spy) as never);
  await editStroke('s1', 'polyline', [[0, 0]], 4);
  expect(spy.selected).toBe('first');
});
