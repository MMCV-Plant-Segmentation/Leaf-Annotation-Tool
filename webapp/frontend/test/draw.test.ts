import { describe, it, expect } from 'vitest';
import { frameUnion } from '../src/analyze/lib/draw';
import type { AnalyzeData, Pile } from '../src/analyze/lib/types';

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

function makeData(piles: Pile[], imageWidth = 640, imageHeight = 480): AnalyzeData {
  return { setId: 'x', displayName: 'x', imageHash: 'x', imageWidth, imageHeight, mTotal: 1, piles };
}

function makePile(id: string, bbox: [number, number, number, number]): Pile {
  return { id, m: 1, bbox, agreementByK: {}, sourceRings: [] };
}

// ── frameUnion ─────────────────────────────────────────────────────────────────

describe('frameUnion', () => {
  it('is a no-op when piles is empty', () => {
    const aView = { zoom: 1, viewX: 5, viewY: 7 };
    frameUnion(makeData([]), makeCanvas(500, 500), aView);
    expect(aView).toEqual({ zoom: 1, viewX: 5, viewY: 7 });
  });

  it('is a no-op when canvas width is 0', () => {
    const aView = { zoom: 1, viewX: 0, viewY: 0 };
    frameUnion(makeData([makePile('P0', [10, 10, 50, 50])]), makeCanvas(0, 500), aView);
    expect(aView.zoom).toBe(1);
  });

  it('centers and fits a square pile in a square canvas', () => {
    // Canvas 200×200, pile [50,50,150,150] (100×100), image 500×500
    // bw=bh=100 → px0=40, py0=40, pw=ph=120
    // zoom = min(200/120, 200/120) * 0.9 = 1.5
    // viewX = viewY = (40+60) − 100/1.5 = 33.333
    const aView = { zoom: 0, viewX: 0, viewY: 0 };
    frameUnion(
      makeData([makePile('P0', [50, 50, 150, 150])], 500, 500),
      makeCanvas(200, 200),
      aView,
    );
    expect(aView.zoom).toBeCloseTo(1.5, 5);
    expect(aView.viewX).toBeCloseTo(33.333, 3);
    expect(aView.viewY).toBeCloseTo(33.333, 3);
  });

  it('is width-limited when the pile is wide relative to the canvas', () => {
    // Canvas 100×400 (tall), pile [0,0,200,100]: pw=220, ph=110
    // min(100/220, 400/110) → 100/220 wins (width-limited)
    const aView = { zoom: 0, viewX: 0, viewY: 0 };
    frameUnion(
      makeData([makePile('P0', [0, 0, 200, 100])], 1000, 1000),
      makeCanvas(100, 400),
      aView,
    );
    const expected = Math.min(100 / 220, 400 / 110) * 0.9;
    expect(aView.zoom).toBeCloseTo(expected, 5);
  });

  it('is height-limited when the pile is tall relative to the canvas', () => {
    // Canvas 400×100 (wide), same pile: min(400/220, 100/110) → 100/110 wins (height-limited)
    const aView = { zoom: 0, viewX: 0, viewY: 0 };
    frameUnion(
      makeData([makePile('P0', [0, 0, 200, 100])], 1000, 1000),
      makeCanvas(400, 100),
      aView,
    );
    const expected = Math.min(400 / 220, 100 / 110) * 0.9;
    expect(aView.zoom).toBeCloseTo(expected, 5);
  });

  it('clamps padding so viewbox does not extend outside the image', () => {
    // Pile at corner [0,0,100,100], image exactly 100×100 — padding would go negative/over
    // px0=max(0,-10)=0, py0=0, pw=ph=100 (clamped by imageWidth/Height)
    // zoom = min(200/100, 200/100) * 0.9 = 1.8
    const aView = { zoom: 0, viewX: 0, viewY: 0 };
    frameUnion(
      makeData([makePile('P0', [0, 0, 100, 100])], 100, 100),
      makeCanvas(200, 200),
      aView,
    );
    expect(aView.zoom).toBeCloseTo(1.8, 5);
    expect(aView.viewX).toBeCloseTo(50 - 100 / 1.8, 3);
    expect(aView.viewY).toBeCloseTo(50 - 100 / 1.8, 3);
  });

  it('uses the union bbox of multiple piles', () => {
    // Piles [0,0,50,50] and [200,200,250,250] → union [0,0,250,250], image 400×400
    // bw=bh=250 → px0=py0=0, pw=ph=min(400,275)=275
    // zoom = (300/275) * 0.9
    const aView = { zoom: 0, viewX: 0, viewY: 0 };
    frameUnion(
      makeData([makePile('P1', [0, 0, 50, 50]), makePile('P2', [200, 200, 250, 250])], 400, 400),
      makeCanvas(300, 300),
      aView,
    );
    const expectedZoom = Math.min(300 / 275, 300 / 275) * 0.9;
    expect(aView.zoom).toBeCloseTo(expectedZoom, 5);
    expect(aView.viewX).toBeCloseTo(137.5 - 150 / expectedZoom, 3);
    expect(aView.viewY).toBeCloseTo(137.5 - 150 / expectedZoom, 3);
  });
});
