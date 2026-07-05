/**
 * Unit tests for the selection-tool hit-testing (lesionSelect.ts).
 * Browserless (Node): pure geometry, no DOM.
 */
import { test, expect } from '@playwright/test';
import { pointInPolygon, annotationHit, hitTestAnnotation } from '../../src/projects/lesionSelect';
import type { CanvasAnnotation } from '../../src/projects/canvasApi';

function ann(kind: string, extra: Partial<CanvasAnnotation> = {}): CanvasAnnotation {
  return {
    id: 'a', kind, passNo: null, points: [], rings: [], label: null, labelColor: null,
    labelSnapshot: null, viewport: null, annotator: 'x', imageId: 'i', ...extra,
  } as CanvasAnnotation;
}

test.describe('pointInPolygon', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  test('inside', () => { expect(pointInPolygon(5, 5, square)).toBe(true); });
  test('outside', () => { expect(pointInPolygon(20, 20, square)).toBe(false); });
  test('concave notch', () => {
    // L-shape: horizontal bar y∈[0,4] x∈[0,10] + vertical bar x∈[0,4] y∈[4,10]
    const c = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    expect(pointInPolygon(5, 2, c)).toBe(true);   // inside the horizontal bar
    expect(pointInPolygon(7, 7, c)).toBe(false);  // in the notch (cut out)
  });
});

test.describe('annotationHit', () => {
  test('stroke mask hits via exterior ring', () => {
    const a = ann('stroke', { rings: [[[0, 0], [20, 0], [20, 20], [0, 20]]] });
    expect(annotationHit(a, 10, 10)).toBe(true);
    expect(annotationHit(a, 30, 30)).toBe(false);
  });
  test('polygon hits', () => {
    const a = ann('polygon', { points: [[0, 0], [10, 0], [10, 10], [0, 10]] });
    expect(annotationHit(a, 5, 5)).toBe(true);
    expect(annotationHit(a, 50, 50)).toBe(false);
  });
  test('point hits within tolerance', () => {
    const a = ann('point', { points: [[100, 100]] });
    expect(annotationHit(a, 102, 103)).toBe(true);   // within 8px
    expect(annotationHit(a, 100, 108)).toBe(true);   // exactly on 8px boundary
    expect(annotationHit(a, 100, 109)).toBe(false);  // just beyond 8px
  });
  test('line hits near a segment', () => {
    const a = ann('line', { points: [[0, 0], [100, 0], [100, 100]] });
    expect(annotationHit(a, 50, 3)).toBe(true);
    expect(annotationHit(a, 100, 50)).toBe(true);
    expect(annotationHit(a, 50, 50)).toBe(false);    // far from both segments
  });
});

test.describe('hitTestAnnotation', () => {
  const anns: CanvasAnnotation[] = [
    ann('stroke', { id: 'bottom', rings: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }),
    ann('point', { id: 'top', points: [[50, 50]] }),
  ];
  test('returns the topmost (last-painted) hit when overlapping', () => {
    // Both overlap at (50,50): point 'top' is painted last → wins.
    expect(hitTestAnnotation(anns, 50, 50)).toBe('top');
  });
  test('returns null for empty space', () => {
    expect(hitTestAnnotation(anns, 999, 999)).toBeNull();
  });
  test('returns the only hit when not overlapping', () => {
    expect(hitTestAnnotation(anns, 10, 10)).toBe('bottom');
  });
});
