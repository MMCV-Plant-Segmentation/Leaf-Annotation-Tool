import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  maxWidth: '1100px',
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

export const title = style({
  margin: 0,
});

export const sub = style({
  color: vars.color.textMuted,
  fontSize: '0.85rem',
});

export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: vars.space.md,
  marginBottom: vars.space.md,
});

export const panel = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
});
globalStyle(`${panel} h3`, { margin: '0 0 0.6rem' });

export const addRow = style({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  marginBottom: '0.5rem',
});
globalStyle(`${addRow} input[type='text']`, {
  flex: '1 1 160px',
  padding: '0.35rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${addRow} button`, {
  padding: '0.35rem 0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});

export const sliderRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  marginBottom: '0.6rem',
});
globalStyle(`${sliderRow} input[type='range']`, { flex: '1 1 200px' });
globalStyle(`${sliderRow} button`, {
  padding: '0.35rem 0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});

export const plainList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});
globalStyle(`${plainList} li`, {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.3rem 0',
  borderBottom: `1px solid ${vars.color.border}`,
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
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

export const thumbGrid = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
  gap: '0.5rem',
});

export const thumb = style({
  border: '2px solid transparent',
  borderRadius: '6px',
  padding: '2px',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  fontSize: '0.7rem',
});
globalStyle(`${thumb} img`, {
  width: '100%',
  height: '70px',
  objectFit: 'contain',
  background: vars.color.bg,
  borderRadius: '4px',
});
globalStyle(`${thumb} span`, {
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.color.textMuted,
});

export const thumbSel = style({
  borderColor: vars.color.accent,
});

export const openAs = style({});
globalStyle(`${openAs} select`, { marginLeft: '0.3rem' });

export const previewBox = style({
  position: 'relative',
  display: 'inline-block',
  maxWidth: '100%',
  background: vars.color.bg,
  borderRadius: '6px',
});
globalStyle(`${previewBox} img`, { display: 'block', maxWidth: '100%', height: 'auto' });

export const previewSvg = style({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
});

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
