import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const checkCtrl = style({
  width: '14px',
  height: '14px',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '2px',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  cursor: 'pointer',
  transition: 'background 0.1s, border-color 0.1s',
  selectors: {
    '&[data-checked]': {
      background: vars.color.accent,
      borderColor: vars.color.accent,
    },
  },
});

export const checkIndicator = style({
  color: 'white',
  fontSize: '10px',
  lineHeight: 1,
  fontWeight: 700,
});

export const compareSetRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '0.88rem',
  padding: '6px 2px',
  cursor: 'pointer',
});
