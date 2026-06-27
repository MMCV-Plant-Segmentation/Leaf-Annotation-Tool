import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const tiles = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '10px',
});

export const tile = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '4px',
  padding: '14px 16px',
  background: vars.color.bg,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'border-color 0.15s, background 0.15s',
  width: '100%',
  selectors: {
    '&:hover:not(:disabled)': {
      borderColor: vars.color.accent,
      background: `color-mix(in srgb, ${vars.color.accent} 6%, transparent)`,
    },
  },
});
globalStyle(`${tile} strong`, { fontSize: '0.88rem', color: vars.color.text });
globalStyle(`${tile} span`,   { fontSize: '0.75rem', color: vars.color.textMuted });

export const tileWide = style({
  gridColumn: '1 / -1',
});

export const tileSoon = style({
  opacity: 0.4,
  cursor: 'not-allowed',
});
