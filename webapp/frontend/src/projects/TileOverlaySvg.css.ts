import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// Default fill: the overlay matches the size of its positioned parent (the lightbox slot).
export const fill = style({
  display: 'block',
  width: '100%',
  height: '100%',
});

// A grid tile: a hit target that fills translucently only while hovered (CSS `fill`
// overrides the transparent presentation attribute). Theme-aware via color-mix so the
// css-hygiene guard (no raw hex/rgba in .css.ts) stays satisfied.
export const gridTile = style({
  pointerEvents: 'auto',
  selectors: {
    '&:hover': { fill: `color-mix(in srgb, ${vars.color.accent} 22%, transparent)` },
  },
});
