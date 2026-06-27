import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const authBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  padding: '0.25rem 0',
  marginBottom: '0.25rem',
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  borderBottom: `1px solid ${vars.color.border}`,
});

// authBar button — use a descendant selector via globalStyle alternative
// (selectors object in style() handles pseudo/child selectors)
export const authBarBtn = style({
  background: 'none',
  border: 'none',
  padding: 0,
  color: vars.color.accent,
  fontSize: '0.82rem',
  cursor: 'pointer',
  textDecoration: 'underline',
  selectors: {
    '&:hover': {
      opacity: 0.75,
    },
  },
});
