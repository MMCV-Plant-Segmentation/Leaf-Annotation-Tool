import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const wrap = style({
  display: 'flex',
  flexDirection: 'column',
  height: 'calc(100vh - 60px)',
  padding: '0.5rem',
  gap: '0.5rem',
});

export const banner = style({
  background: vars.color.danger,
  color: 'white', // danger always needs high-contrast white text (no semantic token for "on-danger")
  padding: '0.4rem 0.75rem',
  borderRadius: '6px',
  fontSize: '0.85rem',
});

export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  flexWrap: 'wrap',
});

export const back = style({
  background: 'none',
  border: 'none',
  color: vars.color.accent,
  cursor: 'pointer',
});

export const who = style({
  fontSize: '0.85rem',
  color: vars.color.textMuted,
});

export const sep = style({
  width: '1px',
  height: '20px',
  background: vars.color.border,
  margin: '0 0.25rem',
});

export const tool = style({
  padding: '0.3rem 0.6rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  cursor: 'pointer',
  fontSize: '0.82rem',
  textTransform: 'capitalize',
});

export const toolActive = style({
  padding: '0.3rem 0.6rem',
  border: `1px solid ${vars.color.accent}`,
  borderRadius: '6px',
  background: vars.color.accent,
  color: vars.color.accentText,
  cursor: 'pointer',
  fontSize: '0.82rem',
  textTransform: 'capitalize',
});

export const danger = style({
  padding: '0.3rem 0.6rem',
  border: `1px solid ${vars.color.danger}`,
  color: vars.color.danger,
  borderRadius: '6px',
  background: vars.color.surface,
  cursor: 'pointer',
  fontSize: '0.82rem',
});

export const classPick = style({
  fontSize: '0.82rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
});

export const stage = style({
  flex: '1 1 auto',
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: vars.color.bg,
  borderRadius: vars.radius.md,
  overflow: 'hidden',
});

export const svg = style({
  maxWidth: '100%',
  maxHeight: '100%',
  touchAction: 'none',
  background: vars.color.bg,
});

export const panning = style({
  cursor: 'grab',
});

export const check = style({
  cursor: 'pointer',
});

export const help = style({
  fontSize: '0.76rem',
  color: vars.color.textMuted,
});
