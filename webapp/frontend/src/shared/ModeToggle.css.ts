import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const modeToggleGroup = style({
  display: 'flex',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  overflow: 'hidden',
  flexShrink: 0,
});

export const modeToggleBtn = style({
  flex: 1,
  padding: '4px 10px',
  fontSize: '0.75rem',
  border: 'none',
  borderRadius: 0,
  background: vars.color.bg,
  color: vars.color.textMuted,
  cursor: 'pointer',
  transition: 'background 0.12s, color 0.12s',
  selectors: {
    '&[data-pressed]': { background: vars.color.accent, color: vars.color.accentText },
    '&:hover:not([data-pressed])': { color: vars.color.text },
  },
});
globalStyle(`${modeToggleBtn}:not(:last-child)`, {
  borderRight: `1px solid ${vars.color.border}`,
});
