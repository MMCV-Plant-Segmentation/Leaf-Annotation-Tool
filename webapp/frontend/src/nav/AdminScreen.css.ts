import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
});

export const tabs = style({
  display: 'flex',
  gap: 0,
  borderBottom: `2px solid ${vars.color.border}`,
});

export const tab = style({
  padding: '0.4rem 1rem',
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  marginBottom: '-2px',
  fontSize: '0.9rem',
  cursor: 'pointer',
  color: vars.color.textMuted,
  selectors: {
    '&[aria-selected="true"]': {
      borderBottomColor: vars.color.accent,
      color: vars.color.accent,
      fontWeight: 600,
    },
  },
});

export const section = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
});

export const sectionTitle = style({
  fontSize: '1rem',
  fontWeight: 600,
  margin: 0,
});

export const addRow = style({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
});
globalStyle(`${addRow} input`, {
  flex: '1',
  padding: '0.35rem 0.55rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  fontSize: '0.9rem',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${addRow} input:focus`, {
  outline: `2px solid ${vars.color.accent}`,
  outlineOffset: '1px',
  borderColor: 'transparent',
});

export const btnAdd = style({
  padding: '0.35rem 0.9rem',
  background: vars.color.accent,
  color: vars.color.accentText,
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.9rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:disabled': { opacity: 0.55, cursor: 'default' },
  },
});

export const userList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
});

export const userRow = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.6rem 0.75rem',
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
});

export const userRowHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
});

export const userName = style({
  fontWeight: 600,
  fontSize: '0.9rem',
  flex: 1,
});

export const badgeNoPass = style({
  fontSize: '0.75rem',
  color: vars.status.warn,
  background: vars.color.dangerBg,
  padding: '0.1rem 0.4rem',
  borderRadius: '3px',
});

export const btnSm = style({
  padding: '0.2rem 0.6rem',
  fontSize: '0.8rem',
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  color: vars.color.text,
  borderRadius: '4px',
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: vars.color.surfaceRaised },
  },
});

export const btnDanger = style({
  color: vars.color.danger,
  borderColor: vars.color.danger,
});

export const inviteRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.8rem',
  color: vars.color.textMuted,
  flexWrap: 'wrap',
});

export const inviteCode = style({
  fontFamily: 'monospace',
  background: vars.color.surfaceRaised,
  padding: '0.1rem 0.35rem',
  borderRadius: '3px',
  fontSize: '0.78rem',
  userSelect: 'all',
});

export const error = style({
  color: vars.color.danger,
  fontSize: '0.85rem',
  minHeight: '1em',
});
