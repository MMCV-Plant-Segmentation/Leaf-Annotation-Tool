import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const card = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem 1rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  background: vars.color.surface,
  maxWidth: '28rem',
  marginBottom: '1rem',
});

export const title = style({
  fontSize: '1rem',
  fontWeight: 600,
  margin: 0,
});

export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  columnGap: '0.75rem',
  rowGap: '0.4rem',
  margin: 0,
  fontSize: '0.9rem',
  alignItems: 'center',
});
globalStyle(`${grid} dt`, {
  color: vars.color.textMuted,
});
globalStyle(`${grid} dd`, {
  margin: 0,
  color: vars.color.text,
});

const pillBase = style({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: '10px',
  fontSize: '0.8rem',
  fontWeight: 600,
});

export const pillGreen = style([
  pillBase,
  {
    background: `color-mix(in srgb, ${vars.status.pass} 15%, transparent)`,
    color: vars.status.pass,
  },
]);

export const pillAmber = style([
  pillBase,
  {
    background: `color-mix(in srgb, ${vars.status.warn} 15%, transparent)`,
    color: vars.status.warn,
  },
]);

export const pillRed = style([
  pillBase,
  {
    background: `color-mix(in srgb, ${vars.status.fail} 15%, transparent)`,
    color: vars.status.fail,
  },
]);

export const backupDirValue = style({
  fontFamily: 'monospace',
  color: vars.color.textMuted,
});
