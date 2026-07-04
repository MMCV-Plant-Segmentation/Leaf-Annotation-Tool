import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// Admin-only viewport-attention heatmap overlay + its controls. Shown in the
// read-only admin canvas view (CanvasScreen when isAdmin). The overlay is an SVG
// layer drawn over the annotation image; the controls live in a floating panel.

export const panel = style({
  position: 'absolute',
  top: '0.5rem',
  right: '0.5rem',
  zIndex: 5,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  padding: '0.5rem 0.6rem',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  fontSize: '0.78rem',
  color: vars.color.text,
  maxWidth: '230px',
});

export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  flexWrap: 'wrap',
});

export const toggle = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  fontWeight: 600,
});

export const checkbox = style({
  cursor: 'pointer',
  accentColor: vars.color.accent,
  width: '14px',
  height: '14px',
});

export const slider = style({
  width: '100px',
  cursor: 'pointer',
  accentColor: vars.color.accent,
});

export const label = style({
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

export const value = style({
  fontFamily: 'monospace',
  fontSize: '0.72rem',
  color: vars.color.text,
  minWidth: '2.4em',
  textAlign: 'right',
});

export const hint = style({
  fontSize: '0.7rem',
  color: vars.color.textMuted,
  lineHeight: 1.25,
});

// The heatmap color ramp swatch (a thin gradient bar) so the admin sees the scale.
export const ramp = style({
  height: '8px',
  width: '100%',
  borderRadius: '4px',
  border: `1px solid ${vars.color.border}`,
});
