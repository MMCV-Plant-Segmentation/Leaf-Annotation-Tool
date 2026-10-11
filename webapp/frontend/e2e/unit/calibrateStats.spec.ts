/**
 * t157 — input-calibration statistics (browserless). The page's verdicts (double delivery,
 * real rate, coalescing) are only as good as these reductions, so they are pinned here.
 *
 *  CS1  duplicate move events (identical time + position) are counted, not mistaken for samples.
 *  CS2  rates count DISTINCT timestamps — exact duplicates don't inflate the Hz.
 *  CS3  coalesced totals / per-event max, raw-update count, and field ranges are reported.
 */
import { test, expect } from '@playwright/test';
import { summarize, distinctRateHz, type CalEvent } from '../../src/calibrate/calibrateStats';

const ev = (kind: CalEvent['kind'], ts: number, x: number, coalesced = 0, over: Partial<CalEvent> = {}): CalEvent => ({
  kind, ts, x, y: 0, coalesced, predicted: 0, pressure: 0.5, tiltX: 30, tiltY: 20, twist: 0,
  altitude: null, azimuth: null, pointerType: 'pen', ...over,
});

test('CS1 — exact double deliveries are counted as duplicates', () => {
  const events = [ev('down', 0, 0), ev('move', 16, 1), ev('move', 16, 1), ev('move', 33, 2), ev('move', 33, 2), ev('up', 40, 3)];
  const s = summarize({ events, samples: [], delegatedMoves: 4 });
  expect(s.moveEvents).toBe(4);
  expect(s.duplicateMoves).toBe(2);
  expect(s.delegatedMoves).toBe(4);
});

test('CS2 — rates use distinct timestamps', () => {
  expect(distinctRateHz([0, 16, 16, 32, 32, 48])).toBeCloseTo(62.5, 1);
  expect(distinctRateHz([0, 4, 8, 12])).toBeCloseTo(250, 1);
  expect(distinctRateHz([5])).toBe(0);
  const samples = [0, 4, 8, 12, 16].map((ts) => ({ ts, x: ts, y: 0 }));
  const s = summarize({ events: [ev('down', 0, 0), ev('move', 16, 16, 4), ev('up', 16, 16)], samples, delegatedMoves: 1 });
  expect(s.sampleHz).toBeCloseTo(250, 1);
  expect(s.medianSampleDtMs).toBe(4);
});

test('CS3 — coalesced, raw-update and field ranges', () => {
  const events = [
    ev('down', 0, 0, 0, { pressure: 0.1 }), ev('raw', 4, 1), ev('move', 8, 2, 3, { pressure: 0.4, tiltX: 40 }),
    ev('move', 16, 3, 1, { pressure: 0.2, altitude: 1.2 }), ev('up', 20, 4, 0, { pressure: 0 }),
  ];
  const s = summarize({ events, samples: [], delegatedMoves: 2 });
  expect(s.coalescedTotal).toBe(4);
  expect(s.coalescedMaxPerEvent).toBe(3);
  expect(s.rawUpdates).toBe(1);
  expect(s.pressure).toEqual([0, 0.4]);
  expect(s.tiltX).toEqual([30, 40]);
  expect(s.altitudeReported).toBe(true);
  expect(s.pointerType).toBe('pen');
});
