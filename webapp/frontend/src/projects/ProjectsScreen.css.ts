import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  maxWidth: '880px',
  margin: '0 auto',
  padding: vars.space.md,
  overflowX: 'hidden',
});

export const title = style({
  margin: `0 0 ${vars.space.md}`,
});

export const createForm = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
});

export const field = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.85rem',
});
globalStyle(`${field} input`, {
  padding: '0.4rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});

export const actions = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
});

export const btnPrimary = style({
  background: vars.color.accent,
  color: vars.color.accentText,
  border: 'none',
  borderRadius: '6px',
  padding: '0.5rem 1rem',
  cursor: 'pointer',
  selectors: {
    '&:disabled': { opacity: 0.6, cursor: 'default' },
  },
});

export const error = style({
  color: vars.color.danger,
  fontSize: '0.85rem',
});

export const empty = style({
  color: vars.color.textMuted,
});

export const list = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: '0.75rem',
});

export const card = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: '0.85rem',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  background: vars.color.surface,
  selectors: {
    '&:hover': { borderColor: vars.color.accent },
  },
});

export const cardName = style({
  fontSize: '1rem',
});

export const cardMeta = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  fontSize: '0.78rem',
  color: vars.color.textMuted,
});
