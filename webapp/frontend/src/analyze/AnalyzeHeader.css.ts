import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const opacityPickWrap = style({
  position: 'relative',
  flexShrink: 0,
});

export const opacityPickBtn = style({
  width: '28px !important' as '28px',
  height: '28px !important' as '28px',
  padding: '3px !important' as '3px',
  borderRadius: '50% !important' as '50%',
  overflow: 'hidden',
  flexShrink: 0,
  // checkered opacity indicator — visual pattern, uses fixed greys
  background: `repeating-conic-gradient(${vars.color.textMuted} 0% 25%, ${vars.color.border} 0% 50%) 0 0 / 8px 8px, ${vars.color.surface} !important` as string,
  border: `1px solid ${vars.color.border} !important` as string,
  cursor: 'pointer',
  selectors: {
    '&:hover': { borderColor: `${vars.color.textMuted} !important` as string },
  },
});

export const opacityPopup = style({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: '10px 12px',
  width: '160px',
  zIndex: 200,
  boxShadow: `0 4px 16px color-mix(in srgb, black 40%, transparent)`,
});

export const rangeInput = style({
  width: '100%',
  accentColor: vars.color.accent,
  cursor: 'pointer',
  height: '4px',
});

export const colorPick = style({
  width: '32px',
  height: '28px',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: '2px',
  cursor: 'pointer',
  background: vars.color.surface,
  flexShrink: 0,
});
