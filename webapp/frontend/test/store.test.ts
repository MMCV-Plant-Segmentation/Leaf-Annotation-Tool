import { describe, it, expect, beforeEach } from 'vitest';
import {
  data as storeData, initStore, setMode,
  kMin, kAgree, setKAgree, mode, iouFilter,
  annotColor, annotOpacity, showBbox, blind,
  selectedId, detailK, setDetailK,
} from '../src/analyze/store';
import type { AnalyzeData } from '../src/analyze/lib/types';

const mockData: AnalyzeData = {
  setId: 'test-set',
  displayName: 'Test Set',
  imageHash: 'abc123',
  imageWidth: 800,
  imageHeight: 600,
  mTotal: 4,
  piles: [],
};

beforeEach(() => { initStore(mockData); });

describe('initStore', () => {
  it('sets store.data', () => { expect(storeData).toBe(mockData); });
  it('resets kMin to 2', () => { expect(kMin()).toBe(2); });
  it('resets kAgree to mTotal', () => { expect(kAgree()).toBe(4); });
  it('resets mode to absolute', () => { expect(mode()).toBe('absolute'); });
  it('resets iouFilter to 0.01', () => { expect(iouFilter()).toBeCloseTo(0.01); });
  it('resets annotColor', () => { expect(annotColor()).toBe('#4a9eff'); });
  it('resets annotOpacity to 0.5', () => { expect(annotOpacity()).toBeCloseTo(0.5); });
  it('resets showBbox to true', () => { expect(showBbox()).toBe(true); });
  it('resets blind to false', () => { expect(blind()).toBe(false); });
  it('resets selectedId to null', () => { expect(selectedId()).toBeNull(); });
  it('resets detailK to null', () => { expect(detailK()).toBeNull(); });
});

describe('setMode', () => {
  it('abs→rel converts kAgree (4 of 4 = 100%)', () => {
    // mTotal=4, kAgree=4 → round(4/4 * 100) = 100
    setMode('relative');
    expect(mode()).toBe('relative');
    expect(kAgree()).toBe(100);
  });

  it('abs→rel partial (3 of 4 = 75%)', () => {
    setKAgree(3);
    setMode('relative');
    expect(kAgree()).toBe(75); // round(3/4 * 100)
  });

  it('rel→abs converts kAgree (75% of 4 = 3)', () => {
    setMode('relative');
    setKAgree(75);
    setMode('absolute');
    expect(kAgree()).toBe(3); // round(75/100 * 4)
  });

  it('same mode is a no-op on kAgree', () => {
    setMode('absolute'); // already absolute, kAgree stays 4
    expect(kAgree()).toBe(4);
  });

  it('resets detailK on mode change', () => {
    setDetailK(2);
    setMode('relative');
    expect(detailK()).toBeNull();
  });
});
