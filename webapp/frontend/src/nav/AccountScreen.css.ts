import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
  maxWidth: '340px',
});

export const title = style({
  fontSize: '1.15rem',
  fontWeight: 600,
  margin: 0,
});

export const section = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  paddingBottom: '1.25rem',
  borderBottom: `1px solid ${vars.color.border}`,
});

export const sectionTitle = style({
  fontSize: '1rem',
  fontWeight: 600,
  margin: 0,
});

export const field = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
});
globalStyle(`${field} label`, {
  fontSize: '0.85rem',
  fontWeight: 500,
  color: vars.color.textMuted,
});
globalStyle(`${field} input`, {
  padding: '0.4rem 0.6rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  fontSize: '0.95rem',
  width: '100%',
  boxSizing: 'border-box',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${field} input:focus`, {
  outline: `2px solid ${vars.color.accent}`,
  outlineOffset: '1px',
  borderColor: 'transparent',
});

// BUG #25: the error/success message slots previously reserved a fixed minHeight
// even when empty, leaving a dead vertical gap between the last input field and
// the Save button. With minHeight:0 + an :empty rule, the slot collapses to zero
// height when there is no message, so the button sits normally below the fields.
export const error = style({
  color: vars.color.danger,
  fontSize: '0.85rem',
  minHeight: 0,
});
globalStyle(`${error}:empty`, {
  margin: 0,
  padding: 0,
});

export const success = style({
  color: vars.status.pass,
  fontSize: '0.85rem',
  minHeight: 0,
});
globalStyle(`${success}:empty`, {
  margin: 0,
  padding: 0,
});

export const submitBtn = style({
  padding: '0.45rem 1.2rem',
  background: vars.color.accent,
  color: vars.color.accentText,
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.95rem',
  cursor: 'pointer',
  alignSelf: 'flex-start',
  selectors: {
    '&:disabled': { opacity: 0.55, cursor: 'default' },
  },
});
