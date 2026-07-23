/**
 * t141 P1b — max-rate rich capture on the brush path (canvasInteraction).
 *
 * Runs BROWSERLESS (Node.js); pointer events are duck-typed. Drives the real interaction
 * controller and asserts the `samples` array handed to `commit`:
 *
 *  CC1  a brush stroke captures one sample per pointer event, in IMAGE space, with
 *       monotonic-from-0 relative `t` and pressure/tilt/twist/pointerType carried through.
 *  CC2  getCoalescedEvents() is expanded — a single pointermove carrying 3 coalesced
 *       sub-samples contributes 3 samples (the max-rate capture, not one-per-frame).
 *  CC3  samples ride ONLY with a persisted brush stroke — an eraser gesture commits none.
 */

import { test, expect } from '@playwright/test';

type Sample = { x: number; y: number; t: number; pressure: number;
  tiltX: number; tiltY: number; twist: number; pointerType: string };

function fakeSvg() {
  // Letterboxed SVG: CTM a=d=1, e=0, f=100 → toImage(x,y) = (x, y-100).
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getScreenCTM: () => ({ a: 1, d: 1, e: 0, f: 100 }),
  } as unknown as SVGSVGElement;
}

type PtrOpts = {
  t: number; pressure?: number; tiltX?: number; tiltY?: number; twist?: number;
  pointerType?: string; coalesced?: Array<[number, number, number]>;
};
function ptrEvent(clientX: number, clientY: number, pointerId: number, o: PtrOpts) {
  const base = {
    clientX, clientY, pointerId, timeStamp: o.t,
    pressure: o.pressure ?? 0.5, tiltX: o.tiltX ?? 0, tiltY: o.tiltY ?? 0,
    twist: o.twist ?? 0, pointerType: o.pointerType ?? 'pen',
    target: { setPointerCapture: () => {} },
  };
  // coalesced: [x, y, t] triples → sub-events inheriting this event's pressure/tilt/type.
  const getCoalescedEvents = o.coalesced
    ? () => o.coalesced!.map(([cx, cy, ct]) => ({ ...base, clientX: cx, clientY: cy, timeStamp: ct }))
    : undefined;
  return { ...base, getCoalescedEvents } as unknown as PointerEvent;
}

async function makeInteraction(tool = 'brush') {
  const { createCanvasInteraction } = await import('../../src/projects/canvasInteraction');
  let _draft: number[][] = [];
  const committed: { kind: string; sw?: number; samples?: Sample[] }[] = [];
  const cx = createCanvasInteraction({
    getSvg: () => fakeSvg(),
    vb: () => ({ x: 0, y: 0, w: 800, h: 600 }),
    setVb: () => {},
    tool: () => tool as 'brush',
    brushSize: () => 20,
    setBrushSize: () => {},
    maxBrushSize: () => 1000,
    draft: () => _draft,
    setDraft: (d) => { _draft = typeof d === 'function' ? (d as (p: number[][]) => number[][])(_draft) : d; },
    commit: (kind, _pts, _passNo, sw, _tool, samples) =>
      committed.push({ kind, sw, samples: samples as Sample[] | undefined }),
  });
  return { cx, committed };
}

test.describe('t141 P1b — brush max-rate capture', () => {
  test('CC1 — one sample per event, image space, monotonic t, rich fields carried', async () => {
    const { cx, committed } = await makeInteraction('brush');
    cx.onPointerDown(ptrEvent(100, 200, 1, { t: 1000, pressure: 0.3, tiltX: -5, tiltY: 2, twist: 10, pointerType: 'pen' }));
    cx.onPointerMove(ptrEvent(120, 210, 1, { t: 1008, pressure: 0.5 }));
    cx.onPointerMove(ptrEvent(140, 205, 1, { t: 1017, pressure: 0.7 }));
    cx.onPointerUp(ptrEvent(150, 200, 1, { t: 1025, pressure: 0.2 }));

    expect(committed).toHaveLength(1);
    const s = committed[0].samples!;
    expect(s).toBeTruthy();
    expect(s).toHaveLength(4);  // down + 2 moves + up

    // Image space: CTM f=100 → sample.y = clientY - 100; x unchanged.
    expect(s[0].x).toBeCloseTo(100);
    expect(s[0].y).toBeCloseTo(100);
    expect(s[3].x).toBeCloseTo(150);
    expect(s[3].y).toBeCloseTo(100);

    // Relative timestamps: first is 0, monotonic non-decreasing.
    expect(s[0].t).toBe(0);
    for (let i = 1; i < s.length; i++) expect(s[i].t).toBeGreaterThanOrEqual(s[i - 1].t);
    expect(s[1].t).toBeCloseTo(8);
    expect(s[3].t).toBeCloseTo(25);

    // Rich fields carried verbatim from the events.
    expect(s[0].pressure).toBeCloseTo(0.3);
    expect(s[0].tiltX).toBeCloseTo(-5);
    expect(s[0].tiltY).toBeCloseTo(2);
    expect(s[0].twist).toBeCloseTo(10);
    expect(s[0].pointerType).toBe('pen');
    expect(s[2].pressure).toBeCloseTo(0.7);
  });

  test('CC2 — getCoalescedEvents is expanded (max-rate, not one-per-frame)', async () => {
    const { cx, committed } = await makeInteraction('brush');
    cx.onPointerDown(ptrEvent(100, 200, 1, { t: 1000 }));
    // One move frame carrying THREE coalesced sub-samples.
    cx.onPointerMove(ptrEvent(120, 208, 1, { t: 1006, coalesced: [[110, 205, 1002], [115, 206, 1004], [120, 208, 1006]] }));
    cx.onPointerUp(ptrEvent(120, 208, 1, { t: 1008 }));

    const s = committed[0].samples!;
    expect(s).toHaveLength(5);  // 1 down + 3 coalesced + 1 up
    // The three coalesced samples landed with their own coords + timestamps.
    expect(s[1].x).toBeCloseTo(110); expect(s[1].t).toBeCloseTo(2);
    expect(s[2].x).toBeCloseTo(115); expect(s[2].t).toBeCloseTo(4);
    expect(s[3].x).toBeCloseTo(120); expect(s[3].t).toBeCloseTo(6);
  });

  test('CC3 — an eraser gesture commits no samples', async () => {
    const { cx, committed } = await makeInteraction('eraser');
    cx.onPointerDown(ptrEvent(100, 200, 1, { t: 1000 }));
    cx.onPointerMove(ptrEvent(120, 210, 1, { t: 1008 }));
    cx.onPointerUp(ptrEvent(140, 205, 1, { t: 1016 }));
    expect(committed).toHaveLength(1);
    expect(committed[0].kind).toBe('erase');
    expect(committed[0].samples).toBeUndefined();
  });
});
