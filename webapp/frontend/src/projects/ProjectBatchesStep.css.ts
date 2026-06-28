import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const panel = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
});
globalStyle(`${panel} h3`, { margin: '0 0 0.6rem' });

export const lockMsg = style({
  color: vars.color.textMuted,
  fontStyle: 'italic',
  margin: '0.25rem 0',
});

export const createRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
  marginBottom: '0.6rem',
});

export const sizeLabel = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.85rem',
});
globalStyle(`${sizeLabel} input[type='number']`, {
  width: '4.5rem',
  padding: '0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${createRow} > button`, {
  padding: '0.35rem 0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});
globalStyle(`${createRow} > button:disabled`, { opacity: 0.5, cursor: 'default' });

export const openAsLabel = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.85rem',
});
globalStyle(`${openAsLabel} select`, {
  padding: '0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});

export const batchList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

export const batchItem = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.3rem 0',
  borderBottom: `1px solid ${vars.color.border}`,
  fontSize: '0.85rem',
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
  padding: '0.3rem 0',
});

export const link = style({
  background: 'none',
  border: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
});
