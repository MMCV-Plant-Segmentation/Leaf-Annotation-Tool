import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  width: '100%',          // fill the (flex-column) parent before maxWidth caps + centers
  maxWidth: '900px',
  margin: '0 auto',
  padding: vars.space.md,
  overflowX: 'hidden',
});

export const header = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.75rem',
  marginBottom: vars.space.md,
  flexWrap: 'wrap',
});

export const back = style({
  background: 'none',
  border: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
  padding: 0,
});

export const title = style({ margin: 0 });

export const sub = style({
  color: vars.color.textMuted,
  fontSize: '0.85rem',
});

export const dangerZone = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
  marginTop: vars.space.lg,
  paddingTop: vars.space.md,
  borderTop: `1px solid ${vars.color.border}`,
});

export const confirmText = style({
  fontSize: '0.85rem',
  color: vars.color.text,
});

export const deleteBtn = style({
  padding: '0.4rem 0.8rem',
  border: `1px solid ${vars.color.danger}`,
  borderRadius: '6px',
  background: vars.color.dangerBg,
  color: vars.color.danger,
  cursor: 'pointer',
  selectors: {
    '&:disabled': { opacity: 0.6, cursor: 'default' },
  },
});

export const cancelBtn = style({
  padding: '0.4rem 0.8rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});
