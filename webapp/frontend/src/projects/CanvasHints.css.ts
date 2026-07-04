import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// BUG #30: layout for the on-demand controls popup that replaces the always-on
// bottom hints bar. The trigger is a small corner "?" button; the panel opens as
// an absolutely-positioned popover laid out vertically (help text, then readout).
// All colours use theme tokens only (no raw literals).

export const hints = style({
  position: 'relative',
  display: 'inline-flex',
});

export const trigger = style({
  width: '1.6rem',
  height: '1.6rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: `1px solid ${vars.color.border}`,
  borderRadius: '50%',
  background: vars.color.surface,
  color: vars.color.textMuted,
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
  lineHeight: 1,
  selectors: {
    '&:hover': { color: vars.color.text, borderColor: vars.color.accent },
    '&:focus-visible': {
      outline: `2px solid ${vars.color.accent}`,
      outlineOffset: '1px',
    },
  },
});

export const panel = style({
  position: 'absolute',
  bottom: 'calc(100% + 0.4rem)',
  right: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  minWidth: '16rem',
  maxWidth: '20rem',
  padding: '0.75rem 0.9rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  background: vars.color.surfaceRaised,
  color: vars.color.text,
  zIndex: 20,
});

export const close = style({
  position: 'absolute',
  top: '0.25rem',
  right: '0.35rem',
  width: '1.4rem',
  height: '1.4rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 'none',
  background: 'none',
  color: vars.color.textMuted,
  fontSize: '0.8rem',
  cursor: 'pointer',
  lineHeight: 1,
  selectors: {
    '&:hover': { color: vars.color.text },
    '&:focus-visible': {
      outline: `2px solid ${vars.color.accent}`,
      outlineOffset: '1px',
    },
  },
});

export const help = style({
  fontSize: '0.78rem',
  lineHeight: 1.4,
  color: vars.color.textMuted,
  paddingRight: '1rem',
});

export const readout = style({
  fontSize: '0.76rem',
  color: vars.color.textMuted,
  fontFamily: 'monospace',
  whiteSpace: 'nowrap',
});
