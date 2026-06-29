import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

/** The outer scrollable viewport container. */
export const container = style({
  position: 'relative',
  overflow: 'hidden',
  width: '100%',
  height: '100%',
  cursor: 'grab',
  userSelect: 'none',
  touchAction: 'none',
  selectors: { '&:active': { cursor: 'grabbing' } },
});

/**
 * The inner canvas: sized to naturalWidth × naturalHeight via inline style,
 * and transformed (translate + scale) to implement zoom/pan.
 * Children (image + overlay) fill this canvas at full image coordinates.
 */
export const canvas = style({
  // Size and transform are set via reactive inline style.
  // Keep this class for testid targeting.
});

/** "Fit" reset button — fixed in the lower-right corner of the viewport. */
export const resetBtn = style({
  position: 'absolute',
  bottom: '0.5rem',
  right: '0.5rem',
  width: '2rem',
  height: '2rem',
  borderRadius: vars.radius.sm,
  border: `1px solid ${vars.color.border}`,
  background: 'color-mix(in srgb, black 55%, transparent)',
  color: 'white',
  fontSize: '1rem',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10,
  opacity: 0.7,
  selectors: { '&:hover': { opacity: 1 } },
});
