/**
 * Polyline click-brush — interaction contract (BROWSERLESS unit, duck-typed events).
 *
 * A polyline is a brush you drive by CLICKING: each click drops a vertex (no drag), a
 * committed stroke carries tool='polyline', and closing the loop (clicking back onto the
 * start) commits a self-closing path that fills solid downstream. See root
 * docs/plans/Plan — Polyline click-brush tool (a11y #40).md.
 *
 * Pins the logic that differs from the brush; rendering (rubber-band, visible vertex dots,
 * fill) is verified end-to-end elsewhere. The commit callback gains a trailing `tool` arg.
 */
import { test, expect } from '@playwright/test';

function kbEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => {}, ...extra };
}
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

async function makePolyline(brushSize = 20) {
  const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
  let _vb = { x: 0, y: 0, w: 800, h: 600 };
  let _draft: number[][] = [];
  const committed: Commit[] = [];
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
    // NOTE: the commit callback gains a trailing `tool` arg for polyline vs brush provenance.
    commit: (kind: string, pts: number[][], passNo?: number, sw?: number, tool?: string) =>
      committed.push({ kind, pts, passNo, sw, tool }),
  } as never);
  const click = (x: number, y: number, id = 1) => {
    cx.onPointerDown(ptrEvent(x, y, id) as unknown as PointerEvent);
    cx.onPointerUp(ptrEvent(x, y, id) as unknown as PointerEvent);
  };
  return { cx, click, draft: () => _draft, committed };
}

test.describe('polyline click-brush interaction', () => {
  test('a click drops a vertex and does NOT commit yet', async () => {
    const { click, draft, committed } = await makePolyline();
    click(400, 300);                       // → image (400, 200)
    expect(draft()).toHaveLength(1);
    expect(draft()[0][0]).toBeCloseTo(400);
    expect(draft()[0][1]).toBeCloseTo(200);
    expect(committed).toHaveLength(0);
  });

  test('further clicks accumulate vertices; a move between clicks adds nothing', async () => {
    const { cx, click, draft, committed } = await makePolyline();
    click(400, 300);
    click(500, 300);                       // → image (500, 200)
    cx.onPointerMove(ptrEvent(550, 320, 1) as unknown as PointerEvent);   // hover only
    expect(draft()).toHaveLength(2);
    expect(committed).toHaveLength(0);
  });

  test('finishing an OPEN polyline commits a stroke tagged tool=polyline', async () => {
    const { cx, click, draft, committed } = await makePolyline();
    click(400, 300);
    click(500, 300);
    click(500, 350);
    cx.finishDraft();                      // ESC / tool-switch path
    expect(committed).toHaveLength(1);
    expect(committed[0].kind).toBe('stroke');
    expect(committed[0].tool).toBe('polyline');
    expect(committed[0].pts).toHaveLength(3);
    expect(committed[0].sw).toBe(20);
    expect(draft()).toHaveLength(0);
  });

  test('clicking back on the start vertex CLOSES the shape and auto-commits a loop', async () => {
    const { click, draft, committed } = await makePolyline();
    click(400, 300);                       // start → image (400, 200)
    click(500, 300);
    click(500, 350);
    click(403, 302);                       // within radius of the start → snap-close
    expect(committed).toHaveLength(1);
    expect(committed[0].tool).toBe('polyline');
    // The committed path is a closed loop: its last point returns to the start vertex.
    const pts = committed[0].pts;
    expect(pts[pts.length - 1][0]).toBeCloseTo(400);
    expect(pts[pts.length - 1][1]).toBeCloseTo(200);
    expect(draft()).toHaveLength(0);
  });

  test('a lone vertex finishes as a single-point stroke (a dot, like the brush)', async () => {
    const { cx, click, committed } = await makePolyline();
    click(400, 300);
    cx.finishDraft();
    expect(committed).toHaveLength(1);
    expect(committed[0].tool).toBe('polyline');
    expect(committed[0].pts).toHaveLength(1);   // one click = one dot of the current radius
  });
});
