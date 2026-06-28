import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const panel = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
});
globalStyle(`${panel} h3`, { margin: '0 0 0.6rem' });

export const table = style({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
});
globalStyle(`${table} th, ${table} td`, {
  textAlign: 'left',
  padding: '0.35rem 0.5rem',
  borderBottom: `1px solid ${vars.color.border}`,
});
