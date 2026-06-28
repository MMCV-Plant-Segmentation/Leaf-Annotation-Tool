import { style } from '@vanilla-extract/css';

// Default fill: the overlay matches the size of its positioned parent (the lightbox slot).
export const fill = style({
  display: 'block',
  width: '100%',
  height: '100%',
});

export const clickable = style({
  cursor: 'zoom-in',
  pointerEvents: 'auto',
});
