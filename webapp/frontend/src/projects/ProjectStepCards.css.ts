import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const cards = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '0.75rem',
  marginBottom: vars.space.md,
});

export const card = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  alignItems: 'flex-start',
  textAlign: 'left',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: '0.85rem',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  font: 'inherit',
  selectors: {
    '&:hover': { borderColor: vars.color.accent },
  },
});
globalStyle(`${card} strong`, { fontSize: '0.95rem' });

export const cardLocked = style({
  cursor: 'default',
  opacity: 0.7,
  selectors: {
    '&:hover': { borderColor: vars.color.border },
  },
});

export const meta = style({
  fontSize: '0.78rem',
  color: vars.color.textMuted,
});

export const lock = style({
  fontSize: '0.78rem',
  color: vars.color.textMuted,
  fontStyle: 'italic',
});
