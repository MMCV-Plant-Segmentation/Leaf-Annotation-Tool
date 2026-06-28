import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const box = style({
  position: 'relative',
  display: 'inline-block',
  maxWidth: '100%',
  // Bigger than the old cramped grid: let the preview use the available width.
  width: 'min(820px, 100%)',
  background: vars.color.bg,
  borderRadius: '6px',
  cursor: 'zoom-in',
});
globalStyle(`${box} img`, { display: 'block', width: '100%', height: 'auto' });

export const svg = style({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
});

export const count = style({
  fontSize: '0.8rem',
  color: vars.color.textMuted,
  marginTop: '0.3rem',
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
});
