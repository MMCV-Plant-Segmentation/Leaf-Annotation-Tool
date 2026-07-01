import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const footer = style({
  position: 'fixed',
  right: '0.5rem',
  bottom: '0.25rem',
  fontSize: '0.7rem',
  color: vars.color.textMuted,
  opacity: 0.6,
  userSelect: 'text',
  zIndex: 1,
});
