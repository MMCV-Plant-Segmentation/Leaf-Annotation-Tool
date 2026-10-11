import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// `-webkit-touch-callout` is a non-standard WebKit property absent from csstype;
// spreading it bypasses the excess-property check (see ZoomPanViewport.css.ts).
const noTouchCallout = { WebkitTouchCallout: 'none' } as const;

// t161: a long-press drawing on the pad must never trigger the browser's own text
// selection/callout on the page around it. The report textarea opts back IN (below).
export const wrap = style({
  display: 'flex', flexDirection: 'column', gap: vars.space.sm, padding: vars.space.md,
  userSelect: 'none', WebkitUserSelect: 'none', ...noTouchCallout,
});

export const bar = style({ display: 'flex', alignItems: 'center', gap: vars.space.md });

export const title = style({ margin: 0, flex: 1, color: vars.color.text });

export const button = style({
  background: vars.color.surfaceRaised, color: vars.color.text,
  border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm,
  padding: `${vars.space.xs} ${vars.space.md}`, cursor: 'pointer',
});

export const hint = style({ margin: 0, color: vars.color.textMuted });

// touch-action none: the pad must receive every pen/touch move, never scroll or zoom the page.
export const pad = style({
  width: '100%', height: '55vh', minHeight: '280px', touchAction: 'none', userSelect: 'none',
  background: vars.color.surface, border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
});

export const stats = style({
  display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: vars.space.md,
  rowGap: vars.space.xs, margin: 0,
});

export const key = style({ color: vars.color.textMuted });

export const val = style({ margin: 0, color: vars.color.text, fontVariantNumeric: 'tabular-nums' });

// Opts back into selection (for copy) against the `wrap` ancestor's user-select: none.
export const report = style({
  width: '100%', minHeight: '6em', fontFamily: 'monospace', fontSize: '12px',
  background: vars.color.surface, color: vars.color.text, border: `1px solid ${vars.color.border}`,
  userSelect: 'text', WebkitUserSelect: 'text',
});
