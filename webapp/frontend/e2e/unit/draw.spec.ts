/**
 * frameUnion — canvas-frame calculation for analyze viewer.
 * Pure algorithm: canvas is mocked as {width, height} — no browser needed.
 */
import { test, expect } from '@playwright/test';
import { frameUnion } from '../../src/analyze/lib/draw';
import type { AnalyzeData, Pile } from '../../src/analyze/lib/types';

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

function makeData(piles: Pile[], imageWidth = 640, imageHeight = 480): AnalyzeData {
  return { setId: 'x', displayName: 'x', imageHash: 'x', imageWidth, imageHeight, mTotal: 1, piles };
}

function makePile(id: string, bbox: [number, number, number, number]): Pile {
  return { id, m: 1, bbox, agreementByK: {}, sourceRings: [] };
}

test('frameUnion is a no-op when piles is empty', () => {
  const aView = { zoom: 1, viewX: 5, viewY: 7 };
  frameUnion(makeData([]), makeCanvas(500, 500), aView);
  expect(aView).toEqual({ zoom: 1, viewX: 5, viewY: 7 });
});

test('frameUnion is a no-op when canvas width is 0', () => {
  const aView = { zoom: 1, viewX: 0, viewY: 0 };
  frameUnion(makeData([makePile('P0', [10, 10, 50, 50])]), makeCanvas(0, 500), aView);
  expect(aView.zoom).toBe(1);
});

test('frameUnion centers and fits a square pile in a square canvas', () => {
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

test('frameUnion is width-limited when pile is wide relative to canvas', () => {
  const aView = { zoom: 0, viewX: 0, viewY: 0 };
  frameUnion(
    makeData([makePile('P0', [0, 0, 200, 100])], 1000, 1000),
    makeCanvas(100, 400),
    aView,
  );
  const expected = Math.min(100 / 220, 400 / 110) * 0.9;
  expect(aView.zoom).toBeCloseTo(expected, 5);
});

test('frameUnion is height-limited when pile is tall relative to canvas', () => {
  const aView = { zoom: 0, viewX: 0, viewY: 0 };
  frameUnion(
    makeData([makePile('P0', [0, 0, 200, 100])], 1000, 1000),
    makeCanvas(400, 100),
    aView,
  );
  const expected = Math.min(400 / 220, 100 / 110) * 0.9;
  expect(aView.zoom).toBeCloseTo(expected, 5);
});

test('frameUnion clamps padding so viewbox does not extend outside image', () => {
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

test('frameUnion uses the union bbox of multiple piles', () => {
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
