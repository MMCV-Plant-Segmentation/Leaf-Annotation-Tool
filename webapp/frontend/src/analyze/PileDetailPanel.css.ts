import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const agreementBreakdown = style({
  paddingTop: '6px',
  borderTop: `1px solid color-mix(in srgb, white 8%, transparent)`,
});

export const breakdownTitle = style({
  fontSize: '0.75rem',
  color: vars.color.textMuted,
  marginBottom: '6px',
});

export const breakdownRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  marginBottom: '4px',
});

export const breakdownRowActive = style({});

export const breakdownK = style({
  fontSize: '0.75rem',
  color: vars.color.textMuted,
  minWidth: '26px',
  textAlign: 'right',
  flexShrink: 0,
});

export const breakdownBarWrap = style({
  flex: 1,
  background: `color-mix(in srgb, white 10%, transparent)`,
  borderRadius: '2px',
  height: '7px',
  overflow: 'hidden',
});

export const breakdownBar = style({
  height: '100%',
  background: vars.color.accent,
  borderRadius: '2px',
  transition: 'width 0.15s ease',
});

export const breakdownPct = style({
  fontSize: '0.75rem',
  color: vars.color.textMuted,
  minWidth: '32px',
  textAlign: 'right',
  flexShrink: 0,
});

// Active row: the parent has both .breakdownRow and .breakdownRowActive;
// use globalStyle to target children of the active parent.
globalStyle(`${breakdownRowActive} ${breakdownBar}`, {
  background: vars.status.warn,
});
globalStyle(`${breakdownRowActive} ${breakdownK}`, {
  color: vars.status.warn,
});
globalStyle(`${breakdownRowActive} ${breakdownPct}`, {
  color: vars.status.warn,
});
