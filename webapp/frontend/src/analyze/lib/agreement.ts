import type { AnalyzeData, Filters, Mode, VisiblePileResult } from './types';

/**
 * Maps the slider value to an integer k for a specific pile.
 * Absolute: kAgree IS k (same for every pile).
 * Relative: kAgree is a percentage → ceil(pct/100 * pile.m), min 1.
 */
export function effectiveKAgree(kAgree: number, pileM: number, mode: Mode): number {
  if (mode === 'absolute') return kAgree;
  return Math.max(1, Math.ceil(kAgree / 100 * pileM));
}

/**
 * Per-ring draw alpha for delta-alpha compositing.
 * Stacking rings 1..ki with this alpha yields cumulative opacity = ki/N * T.
 * T = target total opacity, N = number of annotators (mTotal or pile.m).
 */
export function deltaAlpha(T: number, N: number, ki: number): number {
  const step = T / N;
  return step / (1 - (ki - 1) * step);
}

/**
 * Convert a slider value between absolute and relative modes.
 * abs→rel: round(k / mTotal * 100)
 * rel→abs: round(pct / 100 * mTotal)
 */
export function convertMode(
  value: number,
  from: Mode,
  to: Mode,
  mTotal: number,
): number {
  if (from === to) return value;
  if (from === 'absolute') return Math.round(value / mTotal * 100);
  return Math.round(value / 100 * mTotal);
}

/**
 * Pure filter: given data + filter state, return which piles are visible
 * and their per-pile fraction/lookupK. This is the draw loop's filter logic
 * extracted for testability.
 */
export function computeVisiblePiles(
  data: AnalyzeData,
  filters: Filters,
): { visible: VisiblePileResult[]; filteredCount: number } {
  const { kMin, kAgree, iouFilter, mode } = filters;
  const visible: VisiblePileResult[] = [];
  let filteredCount = 0;

  for (const pile of data.piles) {
    if (pile.m < kMin) { filteredCount++; continue; }

    let fraction = 1;
    let lookupK = kAgree;

    if (kAgree > 0) {
      lookupK = effectiveKAgree(kAgree, pile.m, mode);
      const entry = pile.agreementByK[String(lookupK)];
      fraction = entry ? entry.fraction : 0;
      if (fraction < iouFilter) { filteredCount++; continue; }
    }

    visible.push({ pile, lookupK, fraction });
  }

  return { visible, filteredCount };
}
