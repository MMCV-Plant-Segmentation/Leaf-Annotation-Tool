import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// Custom Kobalte Select trigger, styled to match the toolbar's plain `.tool` buttons
// (see CanvasScreen.css.ts) — a native <select> can't reliably color-code its own
// <option> rows (browser/OS chrome), so the whole item is colour-coded here instead.
export const trigger = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.3rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  cursor: 'pointer',
  fontSize: '0.82rem',
  minWidth: '6rem',
});

export const value = style({
  fontWeight: 600,
});

export const icon = style({
  fontSize: '0.6rem',
  color: vars.color.textMuted,
  marginLeft: 'auto',
});

export const content = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  boxShadow: '0 4px 16px color-mix(in srgb, black 40%, transparent)',
  // Kobalte mounts this content in a Portal on <body> — a SIBLING of the legacy `#setup-screen`
  // shell, which is `position:fixed; z-index:200` and hosts the whole app. So the dropdown has to
  // out-stack that shell (and every in-app overlay, which top out at 210) from the outside, or the
  // setup-screen paints over it and swallows clicks on the options. Sit clearly above all of them.
  zIndex: 1000,
  maxHeight: '16rem',
  overflowY: 'auto',
});

export const listbox = style({
  listStyle: 'none',
  margin: 0,
  padding: '0.25rem',
  outline: 'none',
});

export const item = style({
  padding: '0.3rem 0.6rem',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '0.82rem',
  fontWeight: 600,
  outline: 'none',
  selectors: {
    '&[data-highlighted]': { background: vars.color.surfaceRaised },
    '&[data-selected]': { background: vars.color.surfaceRaised },
  },
});
