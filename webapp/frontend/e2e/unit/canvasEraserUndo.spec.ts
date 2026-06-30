/**
 * Unit tests for Phase-2: canvasHistory (undo/redo + erase) and canvasLesions.
 *
 * Runs BROWSERLESS (Node.js). Mocks globalThis.fetch so no real server is needed.
 *
 * Covers:
 *  - lesionAnnsFor: finds the correct annotation objects for a lesion
 *  - erase: calls mutate(delete), removes from view, pushes to stack
 *  - undo draw: calls mutate(delete), removes annotation
 *  - redo draw: calls mutate(restore), re-adds annotation
 *  - undo erase: calls mutate(restore), re-adds annotations
 *  - redo erase: calls mutate(delete), removes annotations
 *  - canUndo/canRedo signals update correctly
 *  - reset clears the stack
 */

import { test, expect } from '@playwright/test';

// Fake annotation factory
function ann(id: string, label = 'lesion') {
  return { id, kind: 'stroke', passNo: 1, points: [[0, 0]], label, viewport: null, annotator: 'alice', imageId: 'img1', strokeWidth: 10 };
}

// Fake lesion grouping
function lesion(ids: string[], label = 'lesion') {
  return { key: ids[0], label, memberIds: ids };
}

// ── canvasLesions ─────────────────────────────────────────────────────────────

test.describe('lesionAnnsFor', () => {
  test('returns all annotations for the lesion containing the stroke', async () => {
    const { lesionAnnsFor } = await import('../../src/projects/canvasLesions');
    const a1 = ann('a1'); const a2 = ann('a2'); const a3 = ann('a3');
    const lesions = [lesion(['a1', 'a2']), lesion(['a3'])];
    const result = lesionAnnsFor(lesions, 'a1', [a1, a2, a3]);
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a2'].sort());
  });

  test('returns just the stroke itself when not in any multi-member lesion', async () => {
    const { lesionAnnsFor } = await import('../../src/projects/canvasLesions');
    const a1 = ann('a1'); const a2 = ann('a2');
    const lesions = [lesion(['a1']), lesion(['a2'])];
    const result = lesionAnnsFor(lesions, 'a2', [a1, a2]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  test('falls back to id-only lookup when lesions array is empty', async () => {
    const { lesionAnnsFor } = await import('../../src/projects/canvasLesions');
    const a1 = ann('a1');
    const result = lesionAnnsFor([], 'a1', [a1]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });
});


// ── canvasHistory ─────────────────────────────────────────────────────────────

const _origFetch = globalThis.fetch;
function fakeResponse(returnLesions: ReturnType<typeof lesion>[] = []) {
  return { ok: true, status: 200, json: async () => ({ ok: true, ids: [], lesions: returnLesions }) } as Response;
}

async function makeHistory(opts: { initialAnns?: ReturnType<typeof ann>[] } = {}) {
  const { createSignal } = await import('solid-js');
  const { createCanvasHistory } = await import('../../src/projects/canvasHistory');

  let _anns = [...(opts.initialAnns ?? [])];
  let _lesions: ReturnType<typeof lesion>[] = [];

  type ImType = { annotations: typeof _anns; lesions: typeof _lesions };
  const [img, setImg] = createSignal<ImType>({ annotations: _anns, lesions: _lesions });

  const updateImg = (fn: (im: ImType) => ImType) => {
    const next = fn(img());
    _anns = next.annotations;
    _lesions = next.lesions;
    setImg(next);
  };

  const calls: { url: string; body: unknown }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null;
    calls.push({ url, body });
    return fakeResponse([]);
  };

  const history = createCanvasHistory(() => 'proj1', updateImg);
  return { history, getAnns: () => _anns, getLesions: () => _lesions, calls, img };
}

test.afterEach(() => { globalThis.fetch = _origFetch; });


test.describe('canvasHistory: erase', () => {
  test('erase calls mutate(delete) and removes annotations from view', async () => {
    const a1 = ann('a1'); const a2 = ann('a2');
    const { history, getAnns, calls } = await makeHistory({ initialAnns: [a1, a2] });

    await history.erase([a1, a2]);

    expect(calls).toHaveLength(1);
    const body = calls[0].body as { op: string; ids: string[] };
    expect(body.op).toBe('delete');
    expect(body.ids.sort()).toEqual(['a1', 'a2'].sort());
    expect(getAnns().map((a) => a.id)).not.toContain('a1');
    expect(getAnns().map((a) => a.id)).not.toContain('a2');
  });

  test('erase pushes to stack so canUndo becomes true', async () => {
    const a1 = ann('a1');
    const { history } = await makeHistory({ initialAnns: [a1] });
    expect(history.canUndo()).toBe(false);
    await history.erase([a1]);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });
});


test.describe('canvasHistory: undo/redo draw', () => {
  test('undo draw calls mutate(delete)', async () => {
    const a1 = ann('a1');
    const { history, getAnns, calls } = await makeHistory({ initialAnns: [a1] });

    history.push({ kind: 'draw', ann: a1 });
    expect(history.canUndo()).toBe(true);

    await history.undo();

    const body = calls[0].body as { op: string; ids: string[] };
    expect(body.op).toBe('delete');
    expect(body.ids).toContain('a1');
    expect(getAnns().map((a) => a.id)).not.toContain('a1');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  test('redo draw calls mutate(restore) and re-adds annotation', async () => {
    const a1 = ann('a1');
    const { history, getAnns, calls } = await makeHistory({ initialAnns: [a1] });

    history.push({ kind: 'draw', ann: a1 });
    await history.undo();
    calls.length = 0;

    await history.redo();

    const body = calls[0].body as { op: string; ids: string[] };
    expect(body.op).toBe('restore');
    expect(body.ids).toContain('a1');
    expect(getAnns().map((a) => a.id)).toContain('a1');
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });
});


test.describe('canvasHistory: undo/redo erase', () => {
  test('undo erase calls mutate(restore) and re-adds annotations', async () => {
    const a1 = ann('a1'); const a2 = ann('a2');
    const { history, getAnns, calls } = await makeHistory({ initialAnns: [a1, a2] });

    await history.erase([a1, a2]);
    calls.length = 0;

    await history.undo();

    const body = calls[0].body as { op: string; ids: string[] };
    expect(body.op).toBe('restore');
    expect(body.ids.sort()).toEqual(['a1', 'a2'].sort());
    expect(getAnns().map((a) => a.id)).toContain('a1');
    expect(getAnns().map((a) => a.id)).toContain('a2');
  });

  test('redo erase calls mutate(delete)', async () => {
    const a1 = ann('a1');
    const { history, calls } = await makeHistory({ initialAnns: [a1] });

    await history.erase([a1]);
    await history.undo();
    calls.length = 0;

    await history.redo();

    const body = calls[0].body as { op: string; ids: string[] };
    expect(body.op).toBe('delete');
    expect(body.ids).toContain('a1');
  });
});


test.describe('canvasHistory: reset', () => {
  test('reset clears the stack and canUndo/canRedo become false', async () => {
    const a1 = ann('a1');
    const { history } = await makeHistory({ initialAnns: [a1] });

    history.push({ kind: 'draw', ann: a1 });
    expect(history.canUndo()).toBe(true);

    history.reset();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
