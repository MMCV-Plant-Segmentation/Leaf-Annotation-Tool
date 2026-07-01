import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const card = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem 1rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  background: vars.color.surface,
  maxWidth: '28rem',
});

export const title = style({
  fontSize: '1rem',
  fontWeight: 600,
  margin: 0,
});

export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  columnGap: '0.75rem',
  rowGap: '0.3rem',
  margin: 0,
  fontSize: '0.9rem',
});
globalStyle(`${grid} dt`, {
  color: vars.color.textMuted,
});
globalStyle(`${grid} dd`, {
  margin: 0,
  color: vars.color.text,
  fontFamily: 'monospace',
});
