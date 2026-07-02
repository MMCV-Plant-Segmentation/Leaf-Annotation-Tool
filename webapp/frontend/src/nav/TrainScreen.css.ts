import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const slider = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '20px',
  touchAction: 'none',
  userSelect: 'none',
  cursor: 'pointer',
});

export const sliderTrack = style({
  position: 'relative',
  flexGrow: 1,
  height: '4px',
  background: vars.color.border,
  borderRadius: '2px',
});

export const sliderFill = style({
  position: 'absolute',
  height: '100%',
  background: vars.color.accent,
  borderRadius: '2px',
  left: 0,
});

export const sliderThumb = style({
  position: 'absolute',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: '14px',
  height: '14px',
  borderRadius: '50%',
  background: vars.color.accent,
  border: `2px solid ${vars.color.bg}`,
  boxShadow: `0 0 0 1px ${vars.color.accent}`,
  outline: 'none',
  cursor: 'pointer',
  selectors: {
    '&:focus-visible': {
      boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.color.accent} 40%, transparent)`,
    },
  },
});

export const modeChecks = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
});

export const modeCheck = style({
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  padding: '14px 16px',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  cursor: 'pointer',
  transition: 'border-color 0.15s, background 0.15s',
  userSelect: 'none',
  selectors: {
    '&:hover': { borderColor: vars.color.textMuted },
  },
});
// Hide the native checkbox input rendered by Kobalte
globalStyle(`${modeCheck} input[type="checkbox"]`, { display: 'none' });

// CheckboxControl owns the click-to-toggle handler; stretch it to fill the row (flex:1)
// so the whole styled card is clickable, not just a zero-size glyph.
export const modeCheckControl = style({
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  flex: 1,
});

// Modifier class applied when the mode is selected
export const selected = style({
  borderColor: vars.color.accent,
  background: `color-mix(in srgb, ${vars.color.accent} 8%, transparent)`,
  selectors: {
    '&:hover': { borderColor: vars.color.accent },
  },
});

export const modeCheckText = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});
globalStyle(`${modeCheckText} strong`, { fontSize: '0.9rem' });
globalStyle(`${modeCheckText} span`,   { fontSize: '0.78rem', color: vars.color.textMuted });

export const errorText = style({
  fontSize: '0.82rem',
  color: vars.status.fail,
});

export const noticeBanner = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  background: `color-mix(in srgb, ${vars.status.warn} 8%, transparent)`,
  border: `1px solid color-mix(in srgb, ${vars.status.warn} 25%, transparent)`,
  borderRadius: vars.radius.md,
  padding: '8px 12px',
  fontSize: '0.82rem',
  color: vars.color.textMuted,
});

export const noticeDismiss = style({
  background: `none !important` as 'none',
  border: `none !important` as 'none',
  fontSize: `0.7rem !important` as '0.7rem',
  color: vars.color.textMuted,
  cursor: 'pointer',
  padding: `0 2px !important` as '0 2px',
  flexShrink: 0,
  lineHeight: 1,
  selectors: {
    '&:hover': { color: `${vars.color.text} !important` as string },
  },
});

export const countField = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
});
