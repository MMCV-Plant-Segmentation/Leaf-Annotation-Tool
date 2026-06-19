import { describe, it, expect } from 'vitest';
import {
  effectiveKAgree,
  deltaAlpha,
  convertMode,
  computeVisiblePiles,
} from '../src/analyze/lib/agreement';
import type { AnalyzeData } from '../src/analyze/lib/types';

// ── effectiveKAgree ────────────────────────────────────────────────────────────

describe('effectiveKAgree', () => {
  it('absolute mode: returns kAgree unchanged for any pileM', () => {
    expect(effectiveKAgree(2, 1, 'absolute')).toBe(2);
    expect(effectiveKAgree(2, 3, 'absolute')).toBe(2);
    expect(effectiveKAgree(0, 5, 'absolute')).toBe(0);
  });

  it('relative mode: 0% → returns max(1, ceil(0)) = 1', () => {
    // kAgree=0 means slider at 0; still yields at least 1
    expect(effectiveKAgree(0, 3, 'relative')).toBe(1);
  });

  it('relative mode: 100% → pileM', () => {
    expect(effectiveKAgree(100, 1, 'relative')).toBe(1);
    expect(effectiveKAgree(100, 2, 'relative')).toBe(2);
    expect(effectiveKAgree(100, 3, 'relative')).toBe(3);
  });

  it('relative mode: 50% majority', () => {
    expect(effectiveKAgree(50, 1, 'relative')).toBe(1); // ceil(0.5)=1
    expect(effectiveKAgree(50, 2, 'relative')).toBe(1); // ceil(1.0)=1
    expect(effectiveKAgree(50, 3, 'relative')).toBe(2); // ceil(1.5)=2
  });

  it('relative mode: boundaries for pileM=1', () => {
    expect(effectiveKAgree(1,   1, 'relative')).toBe(1);
    expect(effectiveKAgree(50,  1, 'relative')).toBe(1);
    expect(effectiveKAgree(100, 1, 'relative')).toBe(1);
  });

  it('relative mode: boundaries for pileM=3', () => {
    expect(effectiveKAgree(33,  3, 'relative')).toBe(1); // ceil(0.99)=1
    expect(effectiveKAgree(34,  3, 'relative')).toBe(2); // ceil(1.02)=2
    expect(effectiveKAgree(67,  3, 'relative')).toBe(3); // ceil(2.01)=3
    expect(effectiveKAgree(66,  3, 'relative')).toBe(2); // ceil(1.98)=2
  });
});

// ── deltaAlpha ─────────────────────────────────────────────────────────────────

describe('deltaAlpha', () => {
  it('ki=1 equals step', () => {
    // step = T/N; ki=1 → step/(1-0) = step
    const T = 0.5, N = 3;
    expect(deltaAlpha(T, N, 1)).toBeCloseTo(T / N);
  });

  it('property: stacking rings 1..ki reaches cumulative alpha ≈ ki/N*T', () => {
    const T = 0.5, N = 3;
    // Composite alpha: α_total = 1 - ∏(1 - αᵢ)
    // For nested rings: αᵢ = deltaAlpha(T, N, i)
    // Expected: ki/N*T for each ki
    for (let ki = 1; ki <= N; ki++) {
      let cumulative = 0;
      for (let i = 1; i <= ki; i++) {
        const a = deltaAlpha(T, N, i);
        cumulative = cumulative + (1 - cumulative) * a;
      }
      expect(cumulative).toBeCloseTo(ki / N * T, 10);
    }
  });

  it('property holds for T=0.75, N=4', () => {
    const T = 0.75, N = 4;
    for (let ki = 1; ki <= N; ki++) {
      let cumulative = 0;
      for (let i = 1; i <= ki; i++) {
        const a = deltaAlpha(T, N, i);
        cumulative = cumulative + (1 - cumulative) * a;
      }
      expect(cumulative).toBeCloseTo(ki / N * T, 10);
    }
  });

  it('property holds for T=1.0 (full opacity), N=2', () => {
    const T = 1.0, N = 2;
    for (let ki = 1; ki <= N; ki++) {
      let cumulative = 0;
      for (let i = 1; i <= ki; i++) {
        const a = deltaAlpha(T, N, i);
        cumulative = cumulative + (1 - cumulative) * a;
      }
      expect(cumulative).toBeCloseTo(ki / N * T, 10);
    }
  });
});

// ── convertMode ───────────────────────────────────────────────────────────────

describe('convertMode', () => {
  it('no-op when from === to', () => {
    expect(convertMode(3, 'absolute', 'absolute', 5)).toBe(3);
    expect(convertMode(60, 'relative', 'relative', 5)).toBe(60);
  });

  it('abs→rel: round(k / mTotal * 100)', () => {
    expect(convertMode(3, 'absolute', 'relative', 3)).toBe(100);
    expect(convertMode(0, 'absolute', 'relative', 3)).toBe(0);
    expect(convertMode(1, 'absolute', 'relative', 3)).toBe(33);  // round(33.3)
    expect(convertMode(2, 'absolute', 'relative', 3)).toBe(67);  // round(66.7)
  });

  it('rel→abs: round(pct / 100 * mTotal)', () => {
    expect(convertMode(100, 'relative', 'absolute', 3)).toBe(3);
    expect(convertMode(0,   'relative', 'absolute', 3)).toBe(0);
    expect(convertMode(50,  'relative', 'absolute', 3)).toBe(2);  // round(1.5)
    expect(convertMode(33,  'relative', 'absolute', 3)).toBe(1);  // round(0.99)
  });

  it('round-trips are close (not necessarily exact due to rounding)', () => {
    const mTotal = 3;
    for (let k = 0; k <= mTotal; k++) {
      const pct = convertMode(k, 'absolute', 'relative', mTotal);
      const back = convertMode(pct, 'relative', 'absolute', mTotal);
      // Should be within 1 due to rounding
      expect(Math.abs(back - k)).toBeLessThanOrEqual(1);
    }
  });
});

// ── computeVisiblePiles ───────────────────────────────────────────────────────

/** Build a minimal AnalyzeData for testing */
function makeData(piles: { m: number; fractions: number[] }[]): AnalyzeData {
  return {
    setId: 'test',
    imageWidth: 100,
    imageHeight: 100,
    mTotal: 3,
    piles: piles.map((p, i) => ({
      id: `P${i}`,
      m: p.m,
      bbox: [0, 0, 10, 10],
      agreementByK: Object.fromEntries(
        p.fractions.map((frac, ki) => [
          String(ki + 1),
          { fraction: frac, rings: [] },
        ]),
      ),
      sourceRings: [],
    })),
  };
}

describe('computeVisiblePiles', () => {
  it('kMin filter: excludes piles with m < kMin', () => {
    const data = makeData([{ m: 1, fractions: [0.9] }, { m: 3, fractions: [0.9, 0.8, 0.7] }]);
    const { visible, filteredCount } = computeVisiblePiles(data, {
      kMin: 2, kAgree: 0, iouFilter: 0, mode: 'absolute',
    });
    expect(filteredCount).toBe(1);
    expect(visible).toHaveLength(1);
    expect(visible[0].pile.id).toBe('P1');
  });

  it('kAgree=0: all piles above kMin pass with fraction=1', () => {
    const data = makeData([{ m: 2, fractions: [0.5, 0.2] }, { m: 3, fractions: [0.9, 0.5, 0.1] }]);
    const { visible } = computeVisiblePiles(data, {
      kMin: 1, kAgree: 0, iouFilter: 0, mode: 'absolute',
    });
    expect(visible).toHaveLength(2);
    expect(visible.every(r => r.fraction === 1)).toBe(true);
  });

  it('absolute mode: iouFilter excludes piles below threshold', () => {
    // kAgree=2 absolute → lookupK=2 for all piles
    const data = makeData([
      { m: 3, fractions: [0.9, 0.8, 0.6] },  // k=2 fraction=0.8 → passes 0.75
      { m: 3, fractions: [0.9, 0.6, 0.3] },  // k=2 fraction=0.6 → fails 0.75
    ]);
    const { visible, filteredCount } = computeVisiblePiles(data, {
      kMin: 1, kAgree: 2, iouFilter: 0.75, mode: 'absolute',
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].pile.id).toBe('P0');
    expect(filteredCount).toBe(1);
  });

  it('relative mode: kAgree=100% maps to pile.m for each pile', () => {
    // pile 0: m=1, 100%→k=1, fraction=0.9
    // pile 1: m=2, 100%→k=2, fraction=0.4
    const data = makeData([
      { m: 1, fractions: [0.9] },
      { m: 2, fractions: [0.8, 0.4] },
    ]);
    const { visible } = computeVisiblePiles(data, {
      kMin: 1, kAgree: 100, iouFilter: 0, mode: 'relative',
    });
    expect(visible[0].lookupK).toBe(1);
    expect(visible[0].fraction).toBeCloseTo(0.9);
    expect(visible[1].lookupK).toBe(2);
    expect(visible[1].fraction).toBeCloseTo(0.4);
  });

  it('missing agreementByK entry → fraction=0 → filtered by iouFilter>0', () => {
    const data = makeData([{ m: 3, fractions: [0.9] }]); // only k=1 exists
    const { visible, filteredCount } = computeVisiblePiles(data, {
      kMin: 1, kAgree: 2, iouFilter: 0.01, mode: 'absolute', // k=2 not in agreementByK
    });
    expect(visible).toHaveLength(0);
    expect(filteredCount).toBe(1);
  });

  it('all piles pass when no filters active', () => {
    const data = makeData([
      { m: 1, fractions: [0.1] },
      { m: 2, fractions: [0.2, 0.05] },
      { m: 3, fractions: [0.9, 0.7, 0.5] },
    ]);
    const { visible, filteredCount } = computeVisiblePiles(data, {
      kMin: 1, kAgree: 0, iouFilter: 0, mode: 'absolute',
    });
    expect(visible).toHaveLength(3);
    expect(filteredCount).toBe(0);
  });
});
