import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const panel = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
});
globalStyle(`${panel} h3`, { margin: '0 0 0.6rem' });

export const batchList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

export const batchCard = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.sm,
  padding: '0.5rem 0.6rem',
  marginBottom: '0.5rem',
});

export const batchCardHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  marginBottom: '0.3rem',
});

export const batchSeq = style({ fontWeight: 600 });

export const batchTiles = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
});

const badgeBase = style({
  fontSize: '0.72rem',
  fontWeight: 600,
  letterSpacing: '0.03em',
  padding: '1px 6px',
  borderRadius: '10px',
  textTransform: 'uppercase',
});

export const badgeReady = style([badgeBase, {
  background: `color-mix(in srgb, ${vars.status.pass} 15%, transparent)`,
  color: vars.status.pass,
}]);

export const badgeNotReady = style([badgeBase, {
  background: `color-mix(in srgb, ${vars.color.textMuted} 15%, transparent)`,
  color: vars.color.textMuted,
}]);

export const openBtn = style({
  marginLeft: 'auto',
  padding: '0.25rem 0.6rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});

export const memberList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

export const memberRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.2rem 0',
  borderBottom: `1px solid ${vars.color.border}`,
});

export const memberName = style({ flex: '1 1 auto' });

export const memberPercent = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
  padding: '0.3rem 0',
});

export const link = style({
  background: 'none',
  border: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
});

export const linkDanger = style({
  background: 'none',
  border: 'none',
  color: vars.color.danger,
  cursor: 'pointer',
  fontSize: '0.8rem',
});

export const createRow = style({
  display: 'flex',
  gap: '0.6rem',
  alignItems: 'center',
  marginTop: '0.5rem',
});
globalStyle(`${createRow} input[type='number']`, {
  width: '4rem',
  marginLeft: '0.4rem',
  padding: '0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${createRow} button`, {
  padding: '0.35rem 0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});

export const sizeLabel = style({ fontSize: '0.85rem' });

// Modal-specific styles (overlay/positioner/content/confirm/add-row) live in
// BatchMembersModal.css.ts — split out to stay under the 200-line file guard.
