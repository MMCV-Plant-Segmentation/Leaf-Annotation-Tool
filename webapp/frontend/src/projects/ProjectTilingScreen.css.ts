import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  width: '100%',          // fill the (flex-column) parent before maxWidth caps + centers
  maxWidth: '760px',
  margin: '0 auto',
  padding: vars.space.md,
  overflowX: 'hidden',
});

export const header = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.75rem',
  marginBottom: vars.space.md,
  flexWrap: 'wrap',
});

export const back = style({
  background: 'none',
  border: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
  padding: 0,
});

export const title = style({ margin: 0, fontSize: '1.2rem' });

export const lock = style({
  color: vars.color.textMuted,
  fontStyle: 'italic',
});

export const controls = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '1rem',
  flexWrap: 'wrap',
  marginBottom: vars.space.md,
});

export const field = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.85rem',
});
globalStyle(`${field} input[type='range']`, { width: '180px' });
globalStyle(`${field} input[type='number']`, {
  width: '5rem',
  padding: '0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${field} input[type='number']:disabled`, { opacity: 0.5 });

export const bgLabel = style({ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' });

export const tip = style({
  color: vars.color.textMuted,
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  font: 'inherit',
  padding: 0,
  lineHeight: 1,
});

export const popover = style({
  maxWidth: '260px',
  padding: '0.5rem 0.65rem',
  borderRadius: '6px',
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surfaceRaised,
  color: vars.color.text,
  fontSize: '0.8rem',
  boxShadow: '0 4px 16px color-mix(in srgb, black 25%, transparent)',
  zIndex: 210,
});

export const value = style({ color: vars.color.textMuted, fontSize: '0.78rem' });

export const savedOk = style({
  color: vars.status.pass,
  fontSize: '0.82rem',
  fontWeight: 600,
});

export const locked = style({
  color: vars.color.textMuted,
  fontSize: '0.75rem',
  fontStyle: 'italic',
});

export const saveBtn = style({
  padding: '0.4rem 0.8rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  selectors: { '&:disabled': { opacity: 0.5, cursor: 'default' } },
});
