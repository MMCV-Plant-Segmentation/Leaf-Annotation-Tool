import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const iouDetail = style({
  paddingTop: '6px',
  borderTop: `1px solid color-mix(in srgb, white 8%, transparent)`,
});
globalStyle(`${iouDetail} > div`, {
  fontSize: '0.8rem',
  color: vars.color.textMuted,
  marginBottom: '3px',
});
globalStyle(`${iouDetail} > div strong`, { color: vars.color.text });

export const iouDetailResult = style({
  fontSize: '0.78rem',
  fontWeight: 600,
  color: vars.status.warn,
  marginTop: '5px',
});
globalStyle(`${iouDetailResult} strong`, { color: 'inherit' });
