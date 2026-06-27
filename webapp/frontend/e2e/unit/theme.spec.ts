// TDD acceptance test for the Vanilla Extract theme — ACTIVATE at:  e2e/unit/theme.spec.ts
// Imports only PLAIN modules (no VE .css.ts) so it runs in the browserless `unit` project:
//   - src/theme/tokens.ts   exports darkValues, lightValues  (plain objects, no VE)
//   - src/theme/contrast.ts exports contrastRatio(hexA, hexB): number
// See "Plan — Vanilla Extract CSS migration.md".
import { test, expect } from '@playwright/test';
import { darkValues, lightValues } from '../../src/theme/tokens';
import { contrastRatio } from '../../src/theme/contrast';

// Every leaf token both themes MUST define. Mirrors the contract in contract.css.ts.
const LEAF_PATHS = [
  'color.bg', 'color.surface', 'color.surfaceRaised', 'color.border',
  'color.text', 'color.textMuted', 'color.accent', 'color.accentText',
  'color.dangerBg', 'color.danger', 'color.infoBg',
  'status.pass', 'status.fail', 'status.warn', 'status.gt',
  'radius.sm', 'radius.md',
  'space.xs', 'space.sm', 'space.md', 'space.lg', 'space.xl',
];

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

// Self-check: the contrast helper is correct on known anchors (so the AA assertions are trustworthy).
test.describe('contrastRatio helper', () => {
  test('black vs white is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  test('identical colors are 1:1', () => {
    expect(contrastRatio('#4a9eff', '#4a9eff')).toBeCloseTo(1, 2);
  });
});

for (const [name, theme] of [['dark', darkValues], ['light', lightValues]] as const) {
  test.describe(`${name} theme`, () => {
    test('defines every contract token, non-empty', () => {
      for (const p of LEAF_PATHS) {
        const v = at(theme, p);
        expect(typeof v, `${name}.${p} must be a string`).toBe('string');
        expect((v as string).length, `${name}.${p} must be non-empty`).toBeGreaterThan(0);
      }
    });

    // WCAG 2.1 AA. textMuted on bg at the *current* dark #7a7f92 is ~4.1 — expect a small
    // lightening so secondary text passes AA. This is the point of the test.
    test('body + muted text meet AA (4.5:1) on bg', () => {
      expect(contrastRatio(theme.color.text, theme.color.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.color.textMuted, theme.color.bg)).toBeGreaterThanOrEqual(4.5);
    });

    test('accent is a usable UI color and accentText reads on it', () => {
      expect(contrastRatio(theme.color.accent, theme.color.bg)).toBeGreaterThanOrEqual(3.0);
      expect(contrastRatio(theme.color.accentText, theme.color.accent)).toBeGreaterThanOrEqual(4.5);
    });
  });
}

test('both themes implement the same token shape', () => {
  for (const p of LEAF_PATHS) {
    expect(typeof at(darkValues, p)).toBe(typeof at(lightValues, p));
  }
});
