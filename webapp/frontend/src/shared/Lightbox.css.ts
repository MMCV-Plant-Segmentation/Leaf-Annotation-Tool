import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const overlay = style({
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in srgb, black 72%, transparent)',
  zIndex: 200,
});

export const positioner = style({
  position: 'fixed',
  inset: 0,
  zIndex: 201,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: vars.space.lg,
  pointerEvents: 'none',
});

export const content = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  maxWidth: '92vw',
  maxHeight: '92vh',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  pointerEvents: 'auto',
  boxShadow: '0 8px 32px color-mix(in srgb, black 45%, transparent)',
});

export const closeBtn = style({
  position: 'absolute',
  top: '-0.6rem',
  right: '-0.6rem',
  width: '2rem',
  height: '2rem',
  borderRadius: '50%',
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  color: vars.color.text,
  fontSize: '1.2rem',
  lineHeight: 1,
  cursor: 'pointer',
});

// The old shrink-wrapping frame (kept for reference; not used since ZoomPanViewport).
export const frame = style({
  position: 'relative',
  display: 'inline-block',
  lineHeight: 0,
  alignSelf: 'center',
});

// Fallback: shown when natural image dimensions are not yet known (auto-measured).
export const image = style({
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: '88vw',
  maxHeight: '80vh',
  borderRadius: '4px',
  background: vars.color.bg,
});

/**
 * Fixed-size container for ZoomPanViewport (fills the dialog panel's content area).
 * The ZoomPanViewport (overflow:hidden) fills this 100%×100%.
 */
export const viewportWrap = style({
  width: 'min(88vw, 1200px)',
  height: '80vh',
  position: 'relative',
  alignSelf: 'center',
});

/**
 * The image rendered inside the ZoomPanViewport canvas.
 * Canvas is exactly naturalWidth × naturalHeight, so 100%×100% is pixel-perfect.
 */
export const viewportImage = style({
  display: 'block',
  width: '100%',
  height: '100%',
  borderRadius: '4px',
  background: vars.color.bg,
});

/**
 * Overlay slot rendered on top of (and aligned with) the image inside the canvas.
 * pointer-events: none so the blank SVG area doesn't block canvas drag; SVG rect
 * children explicitly set pointer-events: auto to remain clickable.
 */
export const overlaySlot = style({
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
});

export const caption = style({
  fontFamily: 'monospace',
  fontSize: '0.78rem',
  color: vars.color.textMuted,
  textAlign: 'center',
  overflowWrap: 'break-word',
});
