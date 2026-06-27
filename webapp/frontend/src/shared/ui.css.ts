/**
 * Solid-owned UI primitives — migrated from ui.module.css to Vanilla Extract.
 * Solid self-contained: no dependency on the legacy stylesheet.
 */
import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// ── Buttons ──

export const btn = style({
  fontSize: '0.8rem',
  padding: '6px 12px',
  borderRadius: vars.radius.md,
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  color: vars.color.textMuted,
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  textDecoration: 'none',
  display: 'inline-block',
  selectors: {
    '&:hover': { color: vars.color.text, borderColor: vars.color.textMuted },
  },
});

export const btnPrimary = style({
  width: '100%',
  padding: '10px',
  background: vars.color.accent,
  border: 'none',
  borderRadius: vars.radius.md,
  color: vars.color.accentText,
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
  selectors: {
    '&:hover:not(:disabled)': { opacity: 0.85 },
    '&:disabled': { opacity: 0.35, cursor: 'not-allowed' },
  },
});

export const btnSecondary = style({
  flex: 1,
  padding: '7px',
  background: vars.color.bg,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  color: vars.color.textMuted,
  fontSize: '0.8rem',
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  selectors: {
    '&:hover': { color: vars.color.text, borderColor: vars.color.textMuted },
    '&:disabled': { opacity: 0.35, cursor: 'not-allowed' },
  },
});

export const btnText = style({
  background: 'none',
  border: 'none',
  color: vars.color.textMuted,
  fontSize: '0.8rem',
  cursor: 'pointer',
  textDecoration: 'underline',
  padding: 0,
  selectors: {
    '&:hover': { color: vars.color.text },
  },
});

export const btnInfo = style({
  width: '15px',
  height: '15px',
  borderRadius: '50%',
  border: `1px solid ${vars.color.textMuted}`,
  background: 'none',
  color: vars.color.textMuted,
  fontSize: '0.65rem',
  fontWeight: 700,
  cursor: 'pointer',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  marginLeft: '6px',
  lineHeight: 1,
  verticalAlign: 'middle',
  selectors: {
    '&:hover': { color: vars.color.text, borderColor: vars.color.text },
  },
});

// ── Active toggle state ──

export const active = style({
  background: `${vars.color.accent} !important` as string,
  color: `${vars.color.accentText} !important` as string,
  borderColor: `${vars.color.accent} !important` as string,
});

// ── Form inputs ──

export const textInput = style({
  width: '100%',
  padding: '8px 10px',
  background: vars.color.bg,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  color: vars.color.text,
  fontSize: '0.85rem',
  selectors: {
    '&:focus': { outline: 'none', borderColor: vars.color.accent },
  },
});
// ::placeholder — VE doesn't support ::placeholder directly in selectors, use globalStyle
globalStyle(`${textInput}::placeholder`, { color: vars.color.textMuted });

// ── Layout helpers ──

export const field = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
});
globalStyle(`${field} label`, {
  fontSize: '0.72rem',
  color: vars.color.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
});

export const countHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
});
globalStyle(`${countHeader} label`, { fontSize: '0.85rem', color: vars.color.text });

// ── Popover / tooltip content ──

export const iouTooltip = style({
  fontSize: '0.76rem',
  color: vars.color.textMuted,
  background: `color-mix(in srgb, black 25%, transparent)`,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: '8px 10px',
  lineHeight: 1.8,
  marginTop: '6px',
});
globalStyle(`${iouTooltip} p`,      { marginBottom: '4px', lineHeight: 1.5 });
globalStyle(`${iouTooltip} strong`, { color: vars.color.text });

// ── Set kind tags ──

export const setKindTag = style({
  fontSize: '0.65rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  padding: '1px 6px',
  borderRadius: '10px',
  textTransform: 'uppercase',
});

export const setKindRaw = style({
  background: `color-mix(in srgb, ${vars.color.textMuted} 18%, transparent)`,
  color: vars.color.textMuted,
});

export const setKindMerged = style({
  background: `color-mix(in srgb, ${vars.status.warn} 15%, transparent)`,
  color: vars.status.warn,
});

export const setKindReannotated = style({
  background: `color-mix(in srgb, ${vars.status.pass} 15%, transparent)`,
  color: vars.status.pass,
});

export const setKindTerminal = style({
  background: `color-mix(in srgb, ${vars.status.fail} 15%, transparent)`,
  color: vars.status.fail,
});
