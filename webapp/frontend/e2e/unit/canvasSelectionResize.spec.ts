/**
 * t65: resize the selected mask by scrolling. Pure helpers — scaleStrokeSizes (per-vertex
 * size scale) + makeResizeSelected (routes each member stroke through editStroke, returns
 * whether a mask was selected so the caller knows to pan instead).
 */
import { test, expect } from '@playwright/test';
import { scaleStrokeSizes, setStrokeSizes } from '../../src/projects/canvasVertexEdit';
import { makeResizeSelected, makeSetSelectionSize, selectionWidth, createSelectionResize }
  from '../../src/projects/canvasSelectionResize';

test('scaleStrokeSizes scales each point size by the factor, ≥1, width fallback for 2-tuples', () => {
  expect(scaleStrokeSizes([[10, 10, 4], [20, 20, 8]], 1.5, 4)).toEqual([[10, 10, 6], [20, 20, 12]]);
  // a 2-tuple (no stored size) falls back to the stroke width
  expect(scaleStrokeSizes([[0, 0]], 2, 5)).toEqual([[0, 0, 10]]);
  // never shrinks below 1px
  expect(scaleStrokeSizes([[0, 0, 1]], 0.1, 1)[0][2]).toBe(1);
});

test('makeResizeSelected scales EVERY member stroke via editStroke and returns true', () => {
  const calls: { id: string; tool: string; points: number[][]; width: number }[] = [];
  const resize = makeResizeSelected({
    selected: () => ({ id: 'm', strokes: [
      { id: 's1', tool: 'polyline', points: [[0, 0, 10]], strokeWidth: 10 },
      { id: 's2', tool: 'brush', points: [[1, 1, 4]], strokeWidth: 4 },
    ] }) as never,
    editStroke: (id, tool, points, width) => { calls.push({ id, tool, points, width }); },
  });
  expect(resize(1)).toBe(true);           // grow one notch (×1.15)
  expect(calls.map((c) => c.id)).toEqual(['s1', 's2']);
  expect(calls[0].points[0][2]).toBeCloseTo(11.5);
  expect(calls[0].width).toBeCloseTo(11.5);
  expect(calls[1].points[0][2]).toBeCloseTo(4.6);
});

test('makeResizeSelected shrinks on dir=-1 and no-ops (false) with nothing selected', () => {
  const calls: number[] = [];
  const grow = makeResizeSelected({
    selected: () => ({ id: 'm', strokes: [{ id: 's', tool: 'polyline', points: [[0, 0, 10]], strokeWidth: 10 }] }) as never,
    editStroke: (_id, _t, _p, width) => { calls.push(width); },
  });
  expect(grow(-1)).toBe(true);
  expect(calls[0]).toBeCloseTo(10 / 1.15);

  const none = makeResizeSelected({ selected: () => undefined, editStroke: () => { throw new Error('must not resize'); } });
  expect(none(1)).toBe(false);
});

test('setStrokeSizes sets every point to the absolute size (≥1)', () => {
  expect(setStrokeSizes([[10, 10, 4], [20, 20, 8]], 12)).toEqual([[10, 10, 12], [20, 20, 12]]);
  expect(setStrokeSizes([[0, 0]], 0)).toEqual([[0, 0, 1]]);
});

test('makeSetSelectionSize sets EVERY member stroke to the absolute width; selectionWidth reads it', () => {
  const calls: { id: string; points: number[][]; width: number }[] = [];
  const ann = { id: 'm', strokes: [
    { id: 's1', tool: 'polyline', points: [[0, 0, 4]], strokeWidth: 4 },
    { id: 's2', tool: 'brush', points: [[1, 1, 4], [2, 2, 4]], strokeWidth: 4 },
  ] };
  makeSetSelectionSize({ selected: () => ann as never,
    editStroke: (id, _t, points, width) => calls.push({ id, points, width }) })(20);
  expect(calls.map((c) => c.width)).toEqual([20, 20]);
  expect(calls[1].points).toEqual([[1, 1, 20], [2, 2, 20]]);
  expect(selectionWidth(ann as never)).toBe(4);
  expect(selectionWidth(undefined)).toBeNull();
});

test('createSelectionResize bundles all three handles off one deps object', () => {
  const ann = { id: 'm', strokes: [{ id: 's', tool: 'polyline', points: [[0, 0, 6]], strokeWidth: 6 }] };
  const bundle = createSelectionResize({ selected: () => ann as never, editStroke: () => {} });
  expect(typeof bundle.resizeSelected).toBe('function');
  expect(typeof bundle.setSelectionSize).toBe('function');
  expect(bundle.selectionSize()).toBe(6);
});
