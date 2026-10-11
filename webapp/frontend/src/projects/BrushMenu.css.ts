import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// `-webkit-touch-callout` is a non-standard WebKit property (iOS long-press callout —
// "Copy"/"Save Image" menu) absent from csstype; spreading it bypasses the excess-property
// check while keeping the rest of the rule fully type-checked (see ZoomPanViewport.css.ts).
const noTouchCallout = { WebkitTouchCallout: 'none' } as const;

// Positions the popup relative to the button.
export const wrap = style({
  position: 'relative',
  display: 'inline-flex',
});

// t161: the Brush button must never text-select or show the browser's long-press callout —
// a long-press there opens the hidden popup instead.
export const brushButton = style({
  userSelect: 'none',
  WebkitUserSelect: 'none',
  position: 'relative',
  ...noTouchCallout,
});

// Small badge shown on the Brush button while pen mode is on. No equivalent marker exists
// for the hidden popup itself — only this persistent state gets a visual cue.
export const penModeBadge = style({
  position: 'absolute',
  top: '-4px',
  right: '-4px',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: vars.color.accent,
  border: `1px solid ${vars.color.surface}`,
});

export const menu = style({
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: '0.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  padding: '0.3rem',
  minWidth: '140px',
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.sm,
  zIndex: 20,
});

export const menuItem = style({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '0.3rem 0.5rem',
  border: 'none',
  borderRadius: '4px',
  background: 'none',
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.82rem',
  textDecoration: 'none',
});
