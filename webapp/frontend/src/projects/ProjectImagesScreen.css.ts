import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  width: '100%',          // fill the (flex-column) parent before maxWidth caps + centers
  maxWidth: '1200px',
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

export const importRow = style({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  marginBottom: '0.6rem',
  flexWrap: 'wrap',
});
globalStyle(`${importRow} input[type='text']`, {
  flex: '1 1 260px',
  padding: '0.4rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${importRow} button`, {
  padding: '0.4rem 0.8rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});
globalStyle(`${importRow} button:disabled`, { opacity: 0.5, cursor: 'default' });

export const progressWrap = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  marginBottom: '0.5rem',
});

export const progressTrack = style({
  flex: '1 1 auto',
  height: '8px',
  borderRadius: '4px',
  background: vars.color.surfaceRaised,
  overflow: 'hidden',
});

export const progressBar = style({
  height: '100%',
  background: vars.color.accent,
  transition: 'width 0.15s linear',
});

export const progressLabel = style({
  fontSize: '0.8rem',
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

export const summary = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  marginBottom: '0.5rem',
});

export const empty = style({ color: vars.color.textMuted });
