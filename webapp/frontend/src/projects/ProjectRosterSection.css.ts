import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const panel = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
});
globalStyle(`${panel} h3`, { margin: '0 0 0.6rem' });

export const autocompleteWrap = style({
  position: 'relative',
  marginBottom: '0.5rem',
});

export const addRow = style({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
});
globalStyle(`${addRow} input[type='text']`, {
  flex: '1 1 180px',
  padding: '0.35rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${addRow} button`, {
  padding: '0.35rem 0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});
globalStyle(`${addRow} button:disabled`, { opacity: 0.5, cursor: 'default' });

export const dropdown = style({
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  zIndex: 100,
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  margin: '2px 0 0',
  padding: 0,
  listStyle: 'none',
  maxHeight: '180px',
  overflowY: 'auto',
});

export const dropdownItem = style({
  padding: '0.4rem 0.6rem',
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: vars.color.accent, color: vars.color.accentText },
  },
});

export const err = style({
  color: vars.color.danger,
  fontSize: '0.82rem',
  marginTop: '0.25rem',
});

export const rosterList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

export const rosterItem = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.3rem 0',
  borderBottom: `1px solid ${vars.color.border}`,
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
  padding: '0.3rem 0',
});

export const linkDanger = style({
  background: 'none',
  border: 'none',
  color: vars.color.danger,
  cursor: 'pointer',
  fontSize: '0.8rem',
});
