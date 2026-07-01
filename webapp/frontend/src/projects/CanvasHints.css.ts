import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const row = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.75rem',
  flexWrap: 'wrap',
});

export const help = style({
  fontSize: '0.76rem',
  color: vars.color.textMuted,
});

export const readout = style({
  fontSize: '0.76rem',
  color: vars.color.textMuted,
  fontFamily: 'monospace',
  whiteSpace: 'nowrap',
});
