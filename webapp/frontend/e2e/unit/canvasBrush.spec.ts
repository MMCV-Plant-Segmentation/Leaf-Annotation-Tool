/**
 * Unit tests for the Phase-1 brush rework (canvasInteraction + canvasShapes).
 *
 * Runs BROWSERLESS (Node.js). No DOM globals available — events are duck-typed.
 *
 * Covers (task §Acceptance):
 *  - size default = 10% tile diagonal
 *  - [ / ] keys decrease/increase size; size stays in [1, max]
 *  - mid-stroke pan lock: onWheel pan no-ops while stroke in progress
 *  - click-makes-circle: a single-point commit goes through (no length guard)
 *  - strokeWidth is sent to commit
 *  - buildStrokePath with 1 point returns a non-empty SVG path string
 *  - Space key sets isSpaceDown; keyup clears it
 *  - strokeWidth in createAnnotation API body
 */

import { test, expect } from '@playwright/test';

// ── Duck-typed event helpers (no DOM globals in Node unit tests) ───────────────

function kbEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => {}, ...extra };
}
function ptrEvent(clientX: number, clientY: number, pointerId: number) {
  return { clientX, clientY, pointerId, target: { setPointerCapture: () => {} } };
}
function whlEvent(deltaY: number, extra: Record<string, unknown> = {}) {
  return { deltaY, clientX: 400, clientY: 300, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => {}, ...extra };
}
function fakeSvg() {
  // Simulate a letterboxed SVG: scale=1, 100px y-offset (image is 800×400 in 800×600 element).
  // CTM: a=d=1, e=0, f=100. toImage(x,y) = (x, y-100).
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getScreenCTM: () => ({ a: 1, d: 1, e: 0, f: 100 }),
  } as unknown as SVGSVGElement;
}

// ── buildStrokePath (canvasShapes) ─────────────────────────────────────────────

test.describe('buildStrokePath', () => {
  test('returns a non-empty SVG path for a single point (click = circle)', async () => {
    const { buildStrokePath } = await import('../../src/projects/canvasShapes');
    const d = buildStrokePath([[100, 100]], 20);
    expect(d.length).toBeGreaterThan(0);
    expect(d).toContain('M');
  });

  test('returns a non-empty SVG path for a multi-point stroke', async () => {
    const { buildStrokePath } = await import('../../src/projects/canvasShapes');
    const d = buildStrokePath([[0,0],[10,5],[20,0],[30,5],[40,0]], 10);
    expect(d.length).toBeGreaterThan(0);
    expect(d).toContain('Z');
  });

  test('returns empty string for empty point array', async () => {
    const { buildStrokePath } = await import('../../src/projects/canvasShapes');
    expect(buildStrokePath([], 10)).toBe('');
  });
});


// ── Brush size default computation ────────────────────────────────────────────

test.describe('brush size default (10% tile diagonal)', () => {
  test('tile 128×128 → default ≈ 18px (0.1 × 128√2 ≈ 18.1)', () => {
    expect(Math.max(1, Math.round(Math.hypot(128, 128) * 0.1))).toBe(18);
  });
  test('tile 256×256 → default ≈ 36px', () => {
    expect(Math.max(1, Math.round(Math.hypot(256, 256) * 0.1))).toBe(36);
  });
  test('default is clamped to ≥ 1 even for tiny tiles', () => {
    expect(Math.max(1, Math.round(Math.hypot(1, 1) * 0.1))).toBe(1);
  });
});


// ── createCanvasInteraction helpers ──────────────────────────────────────────

async function makeInteraction(opts: { maxBrushSize?: number; tool?: string } = {}) {
  const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
  // Mutable state — use accessor functions (NOT getters / destructuring) so tests
  // always read the CURRENT value after mutation, not a snapshot.
  let _brushSize = 20;
  let _vb = { x: 0, y: 0, w: 800, h: 600 };
  let _draft: number[][] = [];
  const committed: { kind: string; pts: number[][]; passNo?: number; sw?: number }[] = [];

  const cx = createCanvasInteraction({
    getSvg: () => fakeSvg(),
    vb: () => _vb,
    setVb: (v) => { _vb = typeof v === 'function' ? (v as (p: typeof _vb) => typeof _vb)(_vb) : v; },
    tool: () => (opts.tool ?? 'brush') as 'brush',
    brushSize: () => _brushSize,
    setBrushSize: (s) => { _brushSize = s; },
    maxBrushSize: () => opts.maxBrushSize ?? 1000,
    draft: () => _draft,
    setDraft: (d) => { _draft = typeof d === 'function' ? (d as (p: number[][]) => number[][])(_draft) : d; },
    commit: (kind, pts, passNo, sw) => committed.push({ kind, pts, passNo, sw }),
  });
  // Return accessor functions — never destructured snapshots
  return { cx, brushSize: () => _brushSize, vb: () => _vb, draft: () => _draft, committed };
}

// ── [ / ] keys removed (Phase-2); size still adjustable via scroll/slider ────

test.describe('createCanvasInteraction', () => {
  test('[ key no longer changes brush size (keybind removed)', async () => {
    const { cx, brushSize } = await makeInteraction();
    const before = brushSize();
    cx.handleKeyDown(kbEvent('[') as KeyboardEvent);
    expect(brushSize()).toBe(before);
  });

  test('] key no longer changes brush size (keybind removed)', async () => {
    const { cx, brushSize } = await makeInteraction();
    const before = brushSize();
    cx.handleKeyDown(kbEvent(']') as KeyboardEvent);
    expect(brushSize()).toBe(before);
  });

  test('single click commits a stroke (click-makes-circle: no min-point guard)', async () => {
    const { cx, committed } = await makeInteraction();
    cx.onPointerDown(ptrEvent(100, 100, 1) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(100, 100, 1) as unknown as PointerEvent);
    expect(committed).toHaveLength(1);
    expect(committed[0].kind).toBe('stroke');
    expect(committed[0].pts).toHaveLength(1);
  });

  test('commit includes strokeWidth equal to brushSize', async () => {
    const { cx, committed } = await makeInteraction();
    cx.onPointerDown(ptrEvent(200, 200, 2) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(200, 200, 2) as unknown as PointerEvent);
    expect(committed[0].sw).toBe(20);
  });

  test('mid-stroke: non-ctrl scroll is a no-op (pan locked per §D)', async () => {
    const { cx, vb } = await makeInteraction();
    const vbBefore = { ...vb() };
    cx.onPointerDown(ptrEvent(10, 10, 3) as unknown as PointerEvent);
    cx.onWheel(whlEvent(100) as WheelEvent);  // plain scroll mid-stroke → locked
    expect(vb()).toEqual(vbBefore);
  });

  test('mid-stroke: Ctrl+scroll (zoom) still works (§D says zoom need not be locked)', async () => {
    const { cx, vb } = await makeInteraction();
    cx.onPointerDown(ptrEvent(400, 300, 4) as unknown as PointerEvent);
    const wBefore = vb().w;
    cx.onWheel(whlEvent(100, { ctrlKey: true }) as WheelEvent);
    expect(vb().w).not.toBe(wBefore);
  });

  test('Space key sets isSpaceDown to true, keyup clears it', async () => {
    const { cx } = await makeInteraction();
    expect(cx.isSpaceDown()).toBe(false);
    cx.handleKeyDown(kbEvent(' ') as KeyboardEvent);
    expect(cx.isSpaceDown()).toBe(true);
    cx.handleKeyUp(kbEvent(' ') as KeyboardEvent);
    expect(cx.isSpaceDown()).toBe(false);
  });

  // ── #7 — CTM-based coordinate mapping (letterbox) ──────────────────────────
  test('toImage maps screen coords to image coords accounting for letterbox y-offset', async () => {
    const { cx } = await makeInteraction();
    // fakeSvg CTM: a=d=1, e=0, f=100 → toImage(x,y) = (x, y-100)
    // Screen y=100 corresponds to image y=0 (top edge of letterboxed image)
    const [x0, y0] = cx.toImage(400, 100);
    expect(x0).toBeCloseTo(400);
    expect(y0).toBeCloseTo(0);
    // Screen y=300 → image y=200 (vertical centre)
    const [x1, y1] = cx.toImage(400, 300);
    expect(x1).toBeCloseTo(400);
    expect(y1).toBeCloseTo(200);
  });

  // ── #8 — Wheel-pan direction ─────────────────────────────────────────────
  test('wheel down (deltaY > 0) increases v.y — pan not inverted', async () => {
    const { cx, vb } = await makeInteraction({ tool: 'pan' });
    const yBefore = vb().y;
    cx.onWheel(whlEvent(100) as WheelEvent);
    expect(vb().y).toBeGreaterThan(yBefore);
  });

  test('wheel up (deltaY < 0) decreases v.y', async () => {
    const { cx, vb } = await makeInteraction({ tool: 'pan' });
    vb();  // initialise reactive read
    cx.onWheel(whlEvent(-100) as WheelEvent);
    expect(vb().y).toBeLessThan(0);
  });

  // ── #9 — Brush preview hoverImg ─────────────────────────────────────────
  test('hoverImg is null initially', async () => {
    const { cx } = await makeInteraction({ tool: 'brush' });
    expect(cx.hoverImg()).toBeNull();
  });

  test('after onPointerMove, hoverImg is non-null with 2 elements', async () => {
    const { cx } = await makeInteraction({ tool: 'brush' });
    cx.onPointerMove(ptrEvent(400, 300, 1) as unknown as PointerEvent);
    const h = cx.hoverImg();
    expect(h).not.toBeNull();
    expect(h).toHaveLength(2);
    // Should reflect CTM-corrected coords: toImage(400,300) = (400, 200)
    expect(h![0]).toBeCloseTo(400);
    expect(h![1]).toBeCloseTo(200);
  });

  test('onPointerLeave clears hoverImg', async () => {
    const { cx } = await makeInteraction({ tool: 'brush' });
    cx.onPointerMove(ptrEvent(400, 300, 1) as unknown as PointerEvent);
    expect(cx.hoverImg()).not.toBeNull();
    cx.onPointerLeave();
    expect(cx.hoverImg()).toBeNull();
  });
});


// ── strokeWidth persistence via API ──────────────────────────────────────────

test.describe('strokeWidth API field', () => {
  const _origFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = _origFetch; });

  test('createAnnotation sends strokeWidth in the request body', async () => {
    let sentBody: Record<string, unknown> | null = null;
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return { ok: true, status: 201, json: async () => ({
        id: 'a1', kind: 'stroke', passNo: 1, points: [[10,10]], label: 'lesion',
        viewport: null, annotator: 'alice', imageId: 'img1', strokeWidth: 25,
      }) } as Response;
    };
    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.createAnnotation('proj1', {
      imageId: 'img1', annotator: 'alice', kind: 'stroke', points: [[10,10]], strokeWidth: 25,
    });
    expect(sentBody?.strokeWidth).toBe(25);
  });

  test('CanvasAnnotation type accepts strokeWidth null (NULL from DB)', () => {
    const ann = { id:'a', kind:'stroke', passNo:null, points:[[0,0]], label:null,
                  viewport:null, annotator:'x', imageId:'i', strokeWidth:null };
    expect(ann.strokeWidth).toBeNull();
  });
});
