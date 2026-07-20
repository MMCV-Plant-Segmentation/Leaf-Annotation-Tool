/**
 * Polyline per-click persistence — interaction contract (BROWSERLESS unit).
 *
 * Christian's decided model (2026-07-13): a polyline click behaves like a brush stroke
 * on finger-lift — persist + fuse per click. The FE's `polylineStep` callback runs on
 * every click with the growing point list; the persistence layer resolves it as create
 * (1st click) or editStroke (subsequent clicks). No buffered draft that only commits at
 * ESC; no snap-to-first-vertex auto-close; Enter does nothing for polyline; ESC just
 * switches to the select tool (the rubber band vanishes, placed clicks stay persisted).
 *
 * The commit callback still carries tool='polyline' in a trailing arg for the FIRST
 * click (the create path), so persistence tags the stroke's provenance. Subsequent
 * clicks drive editStroke via `polylineStep`, not `commit`.
 */
import { test, expect } from '@playwright/test';

function ptrEvent(clientX: number, clientY: number, pointerId: number) {
  return { clientX, clientY, pointerId, target: { setPointerCapture: () => {} } };
}
function fakeSvg() {
  // CTM a=d=1, e=0, f=100 → toImage(x,y) = (x, y-100).
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getScreenCTM: () => ({ a: 1, d: 1, e: 0, f: 100 }),
  } as unknown as SVGSVGElement;
}

type Commit = { kind: string; pts: number[][]; passNo?: number; sw?: number; tool?: string };
type Step = { pts: number[][]; sw: number };

async function makePolyline(brushSize = 20) {
  const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
  let _vb = { x: 0, y: 0, w: 800, h: 600 };
  let _draft: number[][] = [];
  const committed: Commit[] = [];
  const stepped: Step[] = [];
  const cx = createCanvasInteraction({
    getSvg: () => fakeSvg(),
    vb: () => _vb,
    setVb: (v) => { _vb = typeof v === 'function' ? (v as (p: typeof _vb) => typeof _vb)(_vb) : v; },
    tool: () => 'polyline' as never,
    brushSize: () => brushSize,
    setBrushSize: () => {},
    maxBrushSize: () => 1000,
    draft: () => _draft,
    setDraft: (d) => { _draft = typeof d === 'function' ? (d as (p: number[][]) => number[][])(_draft) : d; },
    commit: (kind: string, pts: number[][], passNo?: number, sw?: number, tool?: string) =>
      committed.push({ kind, pts, passNo, sw, tool }),
    // NEW: per-click persistence hook. The interaction fires this on every polyline click
    // with the growing point list; the persistence layer chooses create vs. editStroke.
    polylineStep: (pts: number[][], sw: number) => stepped.push({ pts, sw }),
  } as never);
  const click = (x: number, y: number, id = 1) => {
    cx.onPointerDown(ptrEvent(x, y, id) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(x, y, id) as unknown as PointerEvent);
  };
  return { cx, click, draft: () => _draft, committed, stepped };
}

test.describe('polyline per-click persistence', () => {
  test('a click drops a vertex AND fires polylineStep with that vertex', async () => {
    const { click, draft, committed, stepped } = await makePolyline();
    click(400, 300);                       // → image (400, 200)
    expect(draft()).toHaveLength(1);
    expect(draft()[0][0]).toBeCloseTo(400);
    expect(draft()[0][1]).toBeCloseTo(200);
    // Per-click persistence: the step callback fires once with a 1-vertex list.
    expect(stepped).toHaveLength(1);
    expect(stepped[0].pts).toHaveLength(1);
    expect(stepped[0].sw).toBe(20);
    // The old commit path did the create; per-click routes create THROUGH polylineStep,
    // NOT through `commit` (persistence sees polylineStep and internally calls create).
    expect(committed).toHaveLength(0);
  });

  test('further clicks fire polylineStep with the GROWING point list — no commit', async () => {
    const { cx, click, draft, committed, stepped } = await makePolyline();
    click(400, 300);
    click(500, 300);                       // → image (500, 200)
    cx.onPointerMove(ptrEvent(550, 320, 1) as unknown as PointerEvent);   // hover only
    expect(draft()).toHaveLength(2);
    expect(stepped).toHaveLength(2);
    expect(stepped[1].pts).toHaveLength(2);
    expect(stepped[1].pts[1][0]).toBeCloseTo(500);
    expect(stepped[1].pts[1][1]).toBeCloseTo(200);
    // A pointer-move (hover) fires no click, so no extra step — the rubber band is FE-only.
    expect(stepped).toHaveLength(2);
    expect(committed).toHaveLength(0);
  });

  test('finishDraft is a NO-OP for polyline — no commit, no step, placed clicks stay', async () => {
    const { cx, click, draft, committed, stepped } = await makePolyline();
    click(400, 300);
    click(500, 300);
    click(500, 350);
    const stepsBefore = stepped.length;
    cx.finishDraft();                      // ESC / tool-switch / Enter path
    // The polyline branch is gone from finishDraft — nothing commits.
    expect(committed).toHaveLength(0);
    expect(stepped).toHaveLength(stepsBefore);
    // The draft (source of the rubber-band) is left to the caller (ESC clears it).
    expect(draft()).toHaveLength(3);
  });

  test('clicking near the first vertex does NOT auto-close — it is just another step', async () => {
    const { click, draft, committed, stepped } = await makePolyline();
    click(400, 300);                       // start → image (400, 200)
    click(500, 300);
    click(500, 350);
    click(403, 302);                       // within the OLD snap radius, but still a plain click
    // No auto-commit; just a normal step with 4 vertices (the last near the first).
    expect(committed).toHaveLength(0);
    expect(stepped).toHaveLength(4);
    expect(stepped[3].pts).toHaveLength(4);
    // The path stays OPEN — the last vertex is the snapped click itself, NOT the start.
    const last = stepped[3].pts[3];
    expect(last[0]).toBeCloseTo(403);
    expect(last[1]).toBeCloseTo(202);
    expect(draft()).toHaveLength(4);
  });

  test('a lone click still triggers polylineStep with a 1-vertex list (a dot)', async () => {
    const { click, committed, stepped } = await makePolyline();
    click(400, 300);
    expect(stepped).toHaveLength(1);
    expect(stepped[0].pts).toHaveLength(1);
    // No `commit` — the create path goes THROUGH polylineStep now, not the direct commit.
    expect(committed).toHaveLength(0);
  });

  test('t62: scrolling between clicks records the brush size PER vertex ([x,y,size])', async () => {
    // Christian (2026-07-19): for a POLYLINE, scrolling while drawing changes the size applied
    // to the NEXT click, and each vertex carries its own size ([x,y,size]) so the stroke width
    // tweens along the path. (Brush ignores mid-stroke scroll — that's a separate concern.)
    const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
    let bs = 10;                                   // mutable brush size (scroll drives it)
    let _draft: number[][] = [];
    const stepped: number[][][] = [];
    const cx = createCanvasInteraction({
      getSvg: () => fakeSvg(), vb: () => ({ x: 0, y: 0, w: 800, h: 600 }), setVb: () => {},
      tool: () => 'polyline', brushSize: () => bs, setBrushSize: (s: number) => { bs = s; },
      maxBrushSize: () => 1000, draft: () => _draft,
      setDraft: (d: number[][] | ((p: number[][]) => number[][])) => {
        _draft = typeof d === 'function' ? d(_draft) : d;
      },
      commit: () => {}, polylineStep: (pts: number[][]) => stepped.push(pts),
    } as never);
    const click = (x: number, y: number) => {
      cx.onPointerDown(ptrEvent(x, y, 1) as unknown as PointerEvent);
      cx.onPointerUp(ptrEvent(x, y, 1) as unknown as PointerEvent);
    };
    click(400, 300);                               // vertex 1 at size 10
    cx.onWheel({ deltaY: -1, preventDefault() {}, shiftKey: false,
                 ctrlKey: false, metaKey: false } as unknown as WheelEvent);   // scroll → grow size
    const grown = bs;
    click(500, 300);                               // vertex 2 at the grown size
    expect(grown).toBeGreaterThan(10);             // sanity: the scroll actually changed the size
    // Each recorded vertex carries its own size as the 3rd tuple element.
    expect(_draft[0][2]).toBe(10);
    expect(_draft[1][2]).toBe(grown);
    expect(_draft[0][2]).not.toBe(_draft[1][2]);   // variable width along the path
    // …and the size rides through the per-click persistence hook too.
    expect(stepped[1][1][2]).toBe(grown);
  });
});
