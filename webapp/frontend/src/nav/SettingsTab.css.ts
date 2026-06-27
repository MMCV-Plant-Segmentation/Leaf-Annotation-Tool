import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const settingsField = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
});
globalStyle(`${settingsField} label`, {
  fontSize: '0.85rem',
  fontWeight: 500,
  color: vars.color.textMuted,
});
globalStyle(`${settingsField} input`, {
  padding: '0.35rem 0.55rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  fontSize: '0.9rem',
  width: '100%',
  boxSizing: 'border-box',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${settingsField} input:focus`, {
  outline: `2px solid ${vars.color.accent}`,
  outlineOffset: '1px',
  borderColor: 'transparent',
});

export const settingsSave = style({
  padding: '0.35rem 1rem',
  background: vars.color.accent,
  color: vars.color.accentText,
  border: 'none',
  borderRadius: '4px',
  fontSize: '0.9rem',
  cursor: 'pointer',
  alignSelf: 'flex-start',
  selectors: {
    '&:disabled': { opacity: 0.55, cursor: 'default' },
  },
});

export const settingsMsg = style({
  fontSize: '0.85rem',
  color: vars.status.pass,
  minHeight: '1em',
});
