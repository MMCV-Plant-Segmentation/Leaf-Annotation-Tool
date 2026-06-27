import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const backdrop = style({
  position: 'fixed',
  inset: 0,
  background: `color-mix(in srgb, black 70%, transparent)`,
  zIndex: 500,
});

export const panel = style({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 501,
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: '16px',
  padding: '28px 32px',
  width: 'min(340px, 90vw)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  outline: 'none',
});

export const title = style({
  fontSize: '1.05rem',
  fontWeight: 700,
  margin: 0,
});

export const sub = style({
  fontSize: '0.85rem',
  color: vars.color.textMuted,
  margin: 0,
});

export const pairEntry = style({
  display: 'flex',
  flexDirection: 'column',
});

export const pairReplaceForm = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  background: `color-mix(in srgb, white 3%, transparent)`,
  border: `1px solid ${vars.color.border}`,
  borderTop: 'none',
  borderRadius: `0 0 ${vars.radius.md} ${vars.radius.md}`,
});

export const pairReplaceFooter = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});
globalStyle(`${pairReplaceFooter} > :first-child`, { flex: '0 1 auto' });

export const pairRenameInput = style({
  fontSize: '0.88rem',
  background: vars.color.bg,
  border: `1px solid ${vars.color.accent}`,
  borderRadius: '4px',
  color: vars.color.text,
  padding: '2px 6px',
  width: '100%',
  outline: 'none',
});

export const pairEditBtn = style({
  flexShrink: 0,
  padding: '2px 6px',
  fontSize: '0.75rem',
  borderRadius: '4px',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  color: vars.color.textMuted,
  cursor: 'pointer',
});

export const pairReplaceBtn = style({
  flexShrink: 0,
  padding: '2px 6px',
  fontSize: '0.75rem',
  borderRadius: '4px',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  color: vars.color.textMuted,
  cursor: 'pointer',
});

export const pairDeleteBtn = style({
  flexShrink: 0,
  padding: '2px 6px',
  fontSize: '0.75rem',
  borderRadius: '4px',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  color: vars.color.textMuted,
  cursor: 'pointer',
  selectors: {
    '&:hover': { color: vars.status.fail, borderColor: vars.status.fail },
  },
});
