import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const section = style({
  marginTop: '1rem',
  padding: '0.75rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  background: vars.color.surface,
  // t73 ROOT CAUSE: as a flex/grid child the editor adopts its content's intrinsic
  // min-width and can push wider than its column; cap it + let min-width:0 below shrink.
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
});

export const head = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
});

export const title = style({
  margin: '0',
  fontSize: '0.95rem',
});

export const summary = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  flex: '1 1 auto',
  minWidth: 0,
  overflowWrap: 'anywhere',
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  marginTop: '0.6rem',
});

export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  // t73: wrap the button cluster onto a new line on narrow widths instead of overflowing.
  flexWrap: 'wrap',
});

export const color = style({
  width: '30px',
  height: '30px',
  padding: '0',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: 'none',
  cursor: 'pointer',
});

export const name = style({
  flex: '1 1 8rem',
  // t73: a text <input> defaults to min-width:auto (~its `size` in ch) and won't shrink as
  // a flex child → row overflow. min-width:0 lets it share the row; border-box caps padding.
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '0.3rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: vars.color.bg,
  color: vars.color.text,
  fontSize: '0.85rem',
});

export const iconBtn = style({
  padding: '0.2rem 0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.8rem',
});

export const danger = style({
  color: vars.color.danger,
});

export const addBtn = style({
  alignSelf: 'flex-start',
  padding: '0.3rem 0.7rem',
  border: `1px dashed ${vars.color.border}`,
  borderRadius: '4px',
  background: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
  fontSize: '0.82rem',
});

export const actions = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.6rem',
});

export const btn = style({
  padding: '0.3rem 0.7rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.82rem',
});

export const err = style({
  color: vars.color.danger,
  fontSize: '0.82rem',
});

export const subTitle = style({
  margin: '0.4rem 0 0.2rem',
  fontSize: '0.85rem',
  color: vars.color.textMuted,
});

export const groupBlock = style({
  padding: '0.5rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.sm,
  background: vars.color.bg,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
});

// t75: members render as a plain, slightly-indented list under the group (the same style
// used elsewhere) — the earlier "tree rail + branch connector" look was reverted.
export const memberList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
  marginLeft: '1rem',
});

export const memberRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  flexWrap: 'wrap',
});

export const checkLabel = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.8rem',
  color: vars.color.textMuted,
});

export const pickerRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
});

export const pickerLabel = style({
  fontSize: '0.8rem',
  color: vars.color.textMuted,
  minWidth: '7rem',
});

export const compoundName = style({
  flex: '1 1 auto',
  minWidth: 0,
  overflowWrap: 'anywhere',
  fontSize: '0.85rem',
  color: vars.color.text,
});

export const swatches = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.3rem',
  marginTop: '0.4rem',
});

export const swatchBtn = style({
  width: '20px',
  height: '20px',
  padding: '0',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  cursor: 'pointer',
});
