import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const section = style({
  marginTop: '1rem',
  padding: '0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  background: vars.color.surface,
});

export const head = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
});

export const title = style({
  margin: '0',
  fontSize: '0.95rem',
});

export const summary = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  flex: '1 1 auto',
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  marginTop: '0.6rem',
});

export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
});

export const color = style({
  width: '30px',
  height: '30px',
  padding: '0',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: 'none',
  cursor: 'pointer',
});

export const name = style({
  flex: '1 1 auto',
  padding: '0.3rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: vars.color.bg,
  color: vars.color.text,
  fontSize: '0.85rem',
});

export const iconBtn = style({
  padding: '0.2rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.8rem',
});

export const danger = style({
  color: vars.color.danger,
});

export const addBtn = style({
  alignSelf: 'flex-start',
  padding: '0.3rem 0.7rem',
  border: `1px dashed ${vars.color.border}`,
  borderRadius: '4px',
  background: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
  fontSize: '0.82rem',
});

export const actions = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.6rem',
});

export const btn = style({
  padding: '0.3rem 0.7rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.82rem',
});

export const err = style({
  color: vars.color.danger,
  fontSize: '0.82rem',
});
