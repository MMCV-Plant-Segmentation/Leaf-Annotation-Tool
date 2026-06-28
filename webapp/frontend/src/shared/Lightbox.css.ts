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

// The frame shrink-wraps the displayed image so an absolutely-positioned overlay (the
// tile SVG) aligns exactly with the rendered pixels (image uses width/height auto).
export const frame = style({
  position: 'relative',
  display: 'inline-block',
  lineHeight: 0,
  alignSelf: 'center',
});

export const image = style({
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: '88vw',
  maxHeight: '80vh',
  borderRadius: '4px',
  background: vars.color.bg,
});

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
