/**
 * Plain token value objects — no VE import, importable in browserless unit tests.
 * Exported shape must match the contract in contract.css.ts.
 *
 * Dark: current app palette, textMuted lightened from #7a7f92 → #9195a6 to pass WCAG AA (≥4.5:1).
 * Light: new accessible palette chosen to pass all contrast checks.
 */

export interface TokenValues {
  color: {
    bg: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentText: string;
    dangerBg: string;
    danger: string;
    infoBg: string;
  };
  status: {
    pass: string;
    fail: string;
    warn: string;
    gt: string;
  };
  radius: {
    sm: string;
    md: string;
  };
  space: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };
}

export const darkValues: TokenValues = {
  color: {
    bg:           '#111318',
    surface:      '#1c1f26',
    surfaceRaised:'#242835',
    border:       '#2e3140',
    text:         '#e2e4ea',
    textMuted:    '#9195a6', // lightened from #7a7f92 — WCAG AA on #111318 (≥4.5:1)
    accent:       '#4a9eff',
    accentText:   '#000d1a', // dark text on bright blue — WCAG AA on #4a9eff
    dangerBg:     '#2d1010',
    danger:       '#f87171',
    infoBg:       '#0f1d2d',
  },
  status: {
    pass: '#4ade80',
    fail: '#f87171',
    warn: '#facc15',
    gt:   '#ff8c42',
  },
  radius: {
    sm: '4px',
    md: '8px',
  },
  space: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
  },
};

export const lightValues: TokenValues = {
  color: {
    bg:           '#f8f9fa',
    surface:      '#ffffff',
    surfaceRaised:'#f1f3f5',
    border:       '#dee2e6',
    text:         '#1a1d23',
    textMuted:    '#495057', // WCAG AA on #f8f9fa: ~7.7:1
    accent:       '#1971c2', // WCAG AA on #f8f9fa: ~4.8:1 (≥3.0 for UI); #fff gives ~5.0:1
    accentText:   '#ffffff',
    dangerBg:     '#fff5f5',
    danger:       '#e03131',
    infoBg:       '#e7f5ff',
  },
  status: {
    pass: '#2f9e44',
    fail: '#c92a2a',
    warn: '#e67700',
    gt:   '#d9480f',
  },
  radius: {
    sm: '4px',
    md: '8px',
  },
  space: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
  },
};
