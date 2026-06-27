import { style } from '@vanilla-extract/css';

export const kBreakdown = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
});

export const kBdBar = style({
  display: 'flex',
  gap: '2px',
  height: '4px',
});

export const kBdSeg = style({
  flex: 1,
  borderRadius: '1px',
});
