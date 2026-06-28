import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// Full-width responsive grid with larger (~2× area) thumbnails. Height-clamped to a few
// rows with a scrollbar (maxHeight is the load-bearing clamp the @full test asserts) so a
// 174-image import scrolls instead of flooding the page.
export const grid = style({
  listStyle: 'none',
  margin: 0,
  padding: '4px',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: '0.75rem',
  maxHeight: '460px',
  overflowY: 'auto',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
});

export const cell = style({
  border: '2px solid transparent',
  borderRadius: '6px',
  padding: '3px',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  fontSize: '0.72rem',
});
globalStyle(`${cell} img`, {
  width: '100%',
  height: '130px',
  objectFit: 'contain',
  background: vars.color.bg,
  borderRadius: '4px',
});
globalStyle(`${cell} span`, {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.color.textMuted,
});

export const cellSel = style({ borderColor: vars.color.accent });
