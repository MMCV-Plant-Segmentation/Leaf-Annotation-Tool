import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const overlay = style({
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in srgb, black 72%, transparent)',
  zIndex: 200,
});

export const positioner = style({
  position: 'fixed',
  inset: 0,
  zIndex: 201,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: vars.space.lg,
});

export const modalContent = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  width: 'min(92vw, 420px)',
  maxHeight: '85vh',
  overflowY: 'auto',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  boxShadow: '0 8px 32px color-mix(in srgb, black 45%, transparent)',
});

export const closeBtn = style({
  position: 'absolute',
  top: '-0.6rem',
  right: '-0.6rem',
  width: '2rem',
  height: '2rem',
  borderRadius: '50%',
  border: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  color: vars.color.text,
  fontSize: '1.2rem',
  lineHeight: 1,
  cursor: 'pointer',
});

export const confirmBox = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  padding: '0.5rem',
  border: `1px solid ${vars.color.danger}`,
  borderRadius: vars.radius.sm,
  fontSize: '0.85rem',
});
globalStyle(`${confirmBox} button`, {
  padding: '0.3rem 0.6rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});

export const addRow = style({
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
});
globalStyle(`${addRow} select`, {
  flex: '1 1 auto',
  padding: '0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
});
globalStyle(`${addRow} button`, {
  padding: '0.3rem 0.6rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
});
globalStyle(`${addRow} button:disabled`, { opacity: 0.5, cursor: 'default' });

export const err = style({
  color: vars.color.danger,
  fontSize: '0.82rem',
});

export const memberList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

export const muted = style({
  color: vars.color.textMuted,
  fontSize: '0.82rem',
  padding: '0.3rem 0',
});
