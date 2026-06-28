import { style } from '@vanilla-extract/css';
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
