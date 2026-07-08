/**
 * Unit tests for the image-grid virtualization math: column count from a measured
 * width, and the visible item-index window (+ spacers) from a scroll position.
 */
import { test, expect } from '@playwright/test';
import { computeColumns, computeWindow } from '../../src/shared/virtualGrid';

test.describe('computeColumns', () => {
  test('fits as many 150px tracks (+12px gap) as the width allows', () => {
    // 4 tracks: 4*150 + 3*12 = 636 <= 648; a 5th would need 786.
    expect(computeColumns(648, 150, 12)).toBe(4);
  });

  test('never returns fewer than 1 column, even at zero/negative width', () => {
    expect(computeColumns(0, 150, 12)).toBe(1);
    expect(computeColumns(-10, 150, 12)).toBe(1);
  });

  test('one extra pixel is not enough for another column', () => {
    const w = 4 * 150 + 3 * 12; // exactly 4 columns
    expect(computeColumns(w + 1, 150, 12)).toBe(4);
    expect(computeColumns(w + 12 + 150, 150, 12)).toBe(5);
  });
});

test.describe('computeWindow', () => {
  test('renders everything with no spacers before geometry is measured', () => {
    const w = computeWindow(1000, 0, 0, 0, 500, 2);
    expect(w).toEqual({ startIndex: 0, endIndex: 1000, padTop: 0, padBottom: 0 });
  });

  test('at scrollTop 0, the window starts at row 0 (no negative overscan)', () => {
    // 4 cols, rowHeight 100, viewport 300 -> ~3 visible rows + 2 overscan below.
    const w = computeWindow(1000, 4, 100, 0, 300, 2);
    expect(w.startIndex).toBe(0);
    expect(w.padTop).toBe(0);
    // visible rows 0..2 (300/100) + 2 overscan = rows 0..4 -> endIndex = 5*4 = 20
    expect(w.endIndex).toBe(20);
  });

  test('scrolled deep into a large list only mounts a small window around scrollTop', () => {
    // 4 cols, 1000 items -> 250 rows. Scrolled to row 100 (scrollTop=10000).
    const w = computeWindow(1000, 4, 100, 10000, 300, 2);
    // startRow = floor(10000/100) - 2 = 98; endRow = ceil(10300/100) + 2 = 105
    expect(w.startIndex).toBe(98 * 4);
    expect(w.endIndex).toBe(105 * 4);
    expect(w.padTop).toBe(98 * 100);
    // totalRows=250, endRow=105 -> padBottom = (250-105)*100
    expect(w.padBottom).toBe(145 * 100);
    // Renders a small bounded slice, not the whole 1000-item list.
    expect(w.endIndex - w.startIndex).toBeLessThan(40);
  });

  test('the window clamps to the item count at the end of the list', () => {
    const w = computeWindow(10, 4, 100, 100000, 300, 2);
    expect(w.endIndex).toBe(10);
    expect(w.padBottom).toBe(0);
  });
});
