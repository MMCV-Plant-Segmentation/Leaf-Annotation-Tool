import { test, expect } from '@playwright/test';
import {
  data as storeData, initStore, setMode,
  kMin, kAgree, setKAgree, mode, iouFilter,
  annotColor, annotOpacity, showBbox, blind,
  selectedId, detailK, setDetailK,
} from '../../src/analyze/store';
import type { AnalyzeData } from '../../src/analyze/lib/types';

const mockData: AnalyzeData = {
  setId: 'test-set',
  displayName: 'Test Set',
  imageHash: 'abc123',
  imageWidth: 800,
  imageHeight: 600,
  mTotal: 4,
  piles: [],
};

test.beforeEach(() => { initStore(mockData); });

test.describe('initStore', () => {
  test('sets store.data',          () => { expect(storeData).toBe(mockData); });
  test('resets kMin to 2',         () => { expect(kMin()).toBe(2); });
  test('resets kAgree to mTotal',  () => { expect(kAgree()).toBe(4); });
  test('resets mode to absolute',  () => { expect(mode()).toBe('absolute'); });
  test('resets iouFilter to 0.01', () => { expect(iouFilter()).toBeCloseTo(0.01); });
  test('resets annotColor',        () => { expect(annotColor()).toBe('#4a9eff'); });
  test('resets annotOpacity to 0.5', () => { expect(annotOpacity()).toBeCloseTo(0.5); });
  test('resets showBbox to true',  () => { expect(showBbox()).toBe(true); });
  test('resets blind to false',    () => { expect(blind()).toBe(false); });
  test('resets selectedId to null',() => { expect(selectedId()).toBeNull(); });
  test('resets detailK to null',   () => { expect(detailK()).toBeNull(); });
});

test.describe('setMode', () => {
  test('abs→rel converts kAgree (4 of 4 = 100%)', () => {
    setMode('relative');
    expect(mode()).toBe('relative');
    expect(kAgree()).toBe(100);
  });

  test('abs→rel partial (3 of 4 = 75%)', () => {
    setKAgree(3);
    setMode('relative');
    expect(kAgree()).toBe(75);
  });

  test('rel→abs converts kAgree (75% of 4 = 3)', () => {
    setMode('relative');
    setKAgree(75);
    setMode('absolute');
    expect(kAgree()).toBe(3);
  });

  test('same mode is a no-op on kAgree', () => {
    setMode('absolute');
    expect(kAgree()).toBe(4);
  });

  test('resets detailK on mode change', () => {
    setDetailK(2);
    setMode('relative');
    expect(detailK()).toBeNull();
  });
});
