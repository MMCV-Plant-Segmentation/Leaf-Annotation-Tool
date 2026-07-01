/**
 * Unit tests for the brush eraser: an invisible brush that deletes whole strokes it
 * drags over (not area-subtraction), routed through canvasInteraction + canvasHistory.
 *
 * Runs BROWSERLESS (Node.js). Mocks globalThis.fetch where needed.
 *
 * Covers:
 *  - eraser tool drag commits kind 'erase' (not 'stroke') with the swept points + brush size
 *  - eraser shares the brush's drag gesture (draft accumulates, strokeInProgress locks pan)
 *  - canvasHistory.applyErase applies an already-server-executed delete WITHOUT calling
 *    mutate again, and pushes ONE erase action
 *  - one drag deleting N strokes → a single undo (mutate restore) brings back all N
 */

import { test, expect } from '@playwright/test';

function ann(id: string) {
  return { id, kind: 'stroke', passNo: 1, points: [[0, 0]], label: 'lesion', viewport: null, annotator: 'alice', imageId: 'img1', strokeWidth: 10 };
}

function ptrEvent(clientX: number, clientY: number, pointerId: number) {
  return { clientX, clientY, pointerId, target: { setPointerCapture: () => {} } };
}
function fakeSvg() {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getScreenCTM: () => ({ a: 1, d: 1, e: 0, f: 0 }),
  } as unknown as SVGSVGElement;
}

// ── canvasInteraction: eraser drag commits kind 'erase' ──────────────────────

async function makeInteraction(tool: string) {
  const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
  let _brushSize = 15;
  let _vb = { x: 0, y: 0, w: 800, h: 600 };
  let _draft: number[][] = [];
  const committed: { kind: string; pts: number[][]; passNo?: number; sw?: number }[] = [];

  const cx = createCanvasInteraction({
    getSvg: () => fakeSvg(),
    vb: () => _vb,
    setVb: (v) => { _vb = typeof v === 'function' ? (v as (p: typeof _vb) => typeof _vb)(_vb) : v; },
    tool: () => tool as 'brush',
    brushSize: () => _brushSize,
    setBrushSize: (s) => { _brushSize = s; },
    maxBrushSize: () => 1000,
    draft: () => _draft,
    setDraft: (d) => { _draft = typeof d === 'function' ? (d as (p: number[][]) => number[][])(_draft) : d; },
    commit: (kind, pts, passNo, sw) => committed.push({ kind, pts, passNo, sw }),
  });
  return { cx, draft: () => _draft, committed };
}

test.describe('eraser tool shares the brush drag gesture', () => {
  test('pointer down→move→up commits kind "erase" (not "stroke")', async () => {
    const { cx, committed } = await makeInteraction('eraser');
    cx.onPointerDown(ptrEvent(100, 100, 1) as unknown as PointerEvent);
    cx.onPointerMove(ptrEvent(120, 100, 1) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(140, 100, 1) as unknown as PointerEvent);
    expect(committed).toHaveLength(1);
    expect(committed[0].kind).toBe('erase');
    expect(committed[0].pts.length).toBeGreaterThanOrEqual(2);
  });

  test('eraser commit carries the current brush size as strokeWidth', async () => {
    const { cx, committed } = await makeInteraction('eraser');
    cx.onPointerDown(ptrEvent(200, 200, 2) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(200, 200, 2) as unknown as PointerEvent);
    expect(committed[0].sw).toBe(15);
  });

  test('a plain brush drag still commits kind "stroke" (unaffected)', async () => {
    const { cx, committed } = await makeInteraction('brush');
    cx.onPointerDown(ptrEvent(50, 50, 3) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(50, 50, 3) as unknown as PointerEvent);
    expect(committed[0].kind).toBe('stroke');
  });

  test('eraser draft accumulates points while dragging, like the brush', async () => {
    const { cx, draft } = await makeInteraction('eraser');
    cx.onPointerDown(ptrEvent(0, 0, 4) as unknown as PointerEvent);
    cx.onPointerMove(ptrEvent(10, 0, 4) as unknown as PointerEvent);
    cx.onPointerMove(ptrEvent(20, 0, 4) as unknown as PointerEvent);
    expect(draft().length).toBe(3);
  });
});


// ── canvasHistory.applyErase: view delta already server-executed ────────────

const _origFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = _origFetch; });

async function makeHistory(initialAnns: ReturnType<typeof ann>[]) {
  const { createSignal } = await import('solid-js');
  const { createCanvasHistory } = await import('../../src/projects/canvasHistory');

  let _anns = [...initialAnns];
  type ImType = { annotations: typeof _anns; lesions: unknown[] };
  const [img, setImg] = createSignal<ImType>({ annotations: _anns, lesions: [] });
  const updateImg = (fn: (im: ImType) => ImType) => {
    const next = fn(img());
    _anns = next.annotations;
    setImg(next);
  };

  const calls: { op: string; ids: string[] }[] = [];
  (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { op: string; ids: string[] };
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, ids: body.ids, lesions: [] }) } as Response;
  };

  const history = createCanvasHistory(() => 'proj1', updateImg);
  return { history, calls, ids: () => img().annotations.map((a) => a.id).sort() };
}

test.describe('canvasHistory.applyErase (brush eraser)', () => {
  test('removes the given ids from the view WITHOUT calling mutate (already server-deleted)', async () => {
    const a = ann('a'); const b = ann('b'); const c = ann('c');
    const { history, calls, ids } = await makeHistory([a, b, c]);

    history.applyErase([a, b], [], []);

    expect(calls).toHaveLength(0);
    expect(ids()).toEqual(['c']);
  });

  test('pushes ONE erase action carrying all N deleted anns, so canUndo is true after one call', async () => {
    const a = ann('a'); const b = ann('b'); const c = ann('c');
    const { history } = await makeHistory([a, b, c]);
    expect(history.canUndo()).toBe(false);

    history.applyErase([a, b, c], [], []);

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  test('a single undo after one multi-stroke eraser drag restores ALL deleted strokes', async () => {
    const a = ann('a'); const b = ann('b'); const c = ann('c');
    const { history, calls, ids } = await makeHistory([a, b, c]);

    // One drag swept 3 strokes; the server already deleted them (calls is empty so far).
    history.applyErase([a, b, c], [], []);
    expect(ids()).toEqual([]);
    expect(calls).toHaveLength(0);

    await history.undo();

    // Undo is the FIRST mutate call for this drag — a single restore('a','b','c').
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('restore');
    expect(calls[0].ids.sort()).toEqual(['a', 'b', 'c']);
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(history.canUndo()).toBe(false);
  });

  test('does nothing for an empty ids list (no annotations actually deleted)', async () => {
    const a = ann('a');
    const { history, calls, ids } = await makeHistory([a]);

    history.applyErase([], [], []);

    expect(calls).toHaveLength(0);
    expect(ids()).toEqual(['a']);
    expect(history.canUndo()).toBe(false);
  });
});
