import { describe, it, expect } from 'vitest';
import { hexToRgba, polygonArea, ptInRing } from '../src/analyze/lib/geometry';
import type { Ring } from '../src/analyze/lib/types';

describe('hexToRgba', () => {
  it('converts a known hex color', () => {
    expect(hexToRgba('#4a9eff', 1.0)).toBe('rgba(74,158,255,1)');
  });
  it('handles zero alpha', () => {
    expect(hexToRgba('#ff0000', 0)).toBe('rgba(255,0,0,0)');
  });
  it('handles white', () => {
    expect(hexToRgba('#ffffff', 0.5)).toBe('rgba(255,255,255,0.5)');
  });
  it('handles black', () => {
    expect(hexToRgba('#000000', 0.35)).toBe('rgba(0,0,0,0.35)');
  });
});

describe('polygonArea', () => {
  it('computes area of a 1×1 unit square', () => {
    const square: Ring = [[0,0],[1,0],[1,1],[0,1]];
    expect(polygonArea([square])).toBeCloseTo(1);
  });
  it('computes area of a 3×4 rectangle', () => {
    const rect: Ring = [[0,0],[3,0],[3,4],[0,4]];
    expect(polygonArea([rect])).toBeCloseTo(12);
  });
  it('computes area of a right triangle (base=3, height=4)', () => {
    const tri: Ring = [[0,0],[3,0],[0,4]];
    expect(polygonArea([tri])).toBeCloseTo(6);
  });
  it('sums area across multiple rings', () => {
    const r1: Ring = [[0,0],[2,0],[2,2],[0,2]];
    const r2: Ring = [[5,5],[6,5],[6,6],[5,6]];
    expect(polygonArea([r1, r2])).toBeCloseTo(5);
  });
  it('returns 0 for empty ring list', () => {
    expect(polygonArea([])).toBe(0);
  });
});

describe('ptInRing', () => {
  const square: Ring = [[0,0],[4,0],[4,4],[0,4]];

  it('returns true for a point inside', () => {
    expect(ptInRing(2, 2, square)).toBe(true);
  });
  it('returns false for a point outside', () => {
    expect(ptInRing(5, 5, square)).toBe(false);
  });
  it('returns false for a point clearly outside to the left', () => {
    expect(ptInRing(-1, 2, square)).toBe(false);
  });
  it('returns true for a point well inside', () => {
    expect(ptInRing(1, 1, square)).toBe(true);
  });
  it('works with a triangle', () => {
    const tri: Ring = [[0,0],[6,0],[3,6]];
    expect(ptInRing(3, 2, tri)).toBe(true);
    expect(ptInRing(0, 6, tri)).toBe(false);
  });
});
