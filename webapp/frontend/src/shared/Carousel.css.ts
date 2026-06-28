import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
});

export const controls = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
});

export const navBtn = style({
  width: '2rem',
  height: '2rem',
  borderRadius: '50%',
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  color: vars.color.text,
  fontSize: '1.2rem',
  lineHeight: 1,
  cursor: 'pointer',
  selectors: {
    '&:hover': { borderColor: vars.color.accent, color: vars.color.accent },
  },
});

export const counter = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  minWidth: '3.5rem',
  textAlign: 'center',
});

export const caption = style({
  fontFamily: 'monospace',
  fontSize: '0.78rem',
  color: vars.color.textMuted,
  textAlign: 'center',
  overflowWrap: 'break-word',
});

export const stage = style({
  display: 'flex',
  justifyContent: 'center',
});
