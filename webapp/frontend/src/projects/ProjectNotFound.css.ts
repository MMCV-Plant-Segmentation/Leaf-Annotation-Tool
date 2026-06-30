import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  padding: vars.space.md,
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.sm,
  alignItems: 'flex-start',
});

export const msg = style({
  color: vars.color.textMuted,
  margin: 0,
});

export const link = style({
  color: vars.color.accent,
  textDecoration: 'none',
  selectors: {
    '&:hover': { textDecoration: 'underline' },
  },
});
