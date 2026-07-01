/**
 * Regression test for BUGS #19: "Ctrl+Z can make a stroke vanish".
 *
 * Root cause (found while implementing #17): the now-removed per-stroke select+delete
 * button called `mutateAnnotations('delete', ...)` directly on a whole lesion's member
 * strokes WITHOUT pushing a history action. That left the undo stack out of sync with
 * the view: a later Ctrl+Z would pop some unrelated earlier `draw` action and delete
 * *that* annotation instead (it was still the real top-of-stack), silently vanishing a
 * stroke the user never touched. #17 deletes that whole code path — the eraser
 * (`history.erase`) is now the only way to delete from the canvas, and it always
 * pushes exactly the ids it deleted.
 *
 * This test pins the invariant that protects against any future regression of this
 * kind: undo only ever affects exactly what was pushed, in order, never an unrelated
 * still-visible annotation — even across a merge (lesion erase of >1 stroke) followed
 * by a string of undos that walk back through earlier individual draws.
 *
 * Runs BROWSERLESS (Node.js); mocks globalThis.fetch so no real server is needed.
 */
import { test, expect } from '@playwright/test';

function ann(id: string, label = 'lesion') {
  return { id, kind: 'stroke', passNo: 1, points: [], rings: [[[0, 0], [1, 0], [1, 1]]],
    label, viewport: null, annotator: 'alice', imageId: 'img1' };
}

const _origFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = _origFetch; });

test('undo after a merged-lesion erase only ever touches its own ids — an unrelated earlier stroke survives until its own undo', async () => {
  const { createSignal } = await import('solid-js');
  const { createCanvasHistory } = await import('../../src/projects/canvasHistory');

  const x = ann('x'); // unrelated stroke, drawn first, never erased
  const a = ann('a'); // merges with b below
  const b = ann('b');

  type ImType = { annotations: { id: string }[] };
  let _anns = [x, a, b];
  const [img, setImg] = createSignal<ImType>({ annotations: _anns });
  const updateImg = (fn: (im: ImType) => ImType) => { const next = fn(img()); _anns = next.annotations; setImg(next); };

  const calls: { op: string; ids: string[] }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { op: string; ids: string[] };
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, ids: body.ids, tileStates: [] }) } as Response;
  };

  const history = createCanvasHistory(() => 'proj1', updateImg);
  const ids = () => img().annotations.map((an) => an.id).sort();

  // Draw x, then a, then b (b merges with a — the FE doesn't care about the merge
  // itself, only that each draw is its own push).
  history.push({ kind: 'draw', ann: x });
  history.push({ kind: 'draw', ann: a });
  history.push({ kind: 'draw', ann: b });

  // Erase the merged lesion {a, b} as one eraser action (the only delete path now).
  await history.erase([a, b]);
  expect(ids()).toEqual(['x']);

  // Undo 1: restores the erased lesion {a, b} — x untouched throughout.
  await history.undo();
  expect(calls.at(-1)).toEqual({ op: 'restore', ids: expect.arrayContaining(['a', 'b']) });
  expect(ids()).toEqual(['a', 'b', 'x']);

  // Undo 2: undoes the draw of b only — a and x must remain.
  await history.undo();
  expect(calls.at(-1)).toEqual({ op: 'delete', ids: ['b'] });
  expect(ids()).toEqual(['a', 'x']);

  // Undo 3: undoes the draw of a — x must still remain (this is the assertion that
  // would have failed under the old bug: x is an unrelated stroke that was never
  // part of the erased lesion and must not vanish here or at any earlier step).
  await history.undo();
  expect(calls.at(-1)).toEqual({ op: 'delete', ids: ['a'] });
  expect(ids()).toEqual(['x']);

  // Undo 4: only now does x's own draw get undone.
  await history.undo();
  expect(calls.at(-1)).toEqual({ op: 'delete', ids: ['x'] });
  expect(ids()).toEqual([]);
  expect(history.canUndo()).toBe(false);
});
