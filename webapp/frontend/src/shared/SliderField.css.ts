import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const slider = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '20px',
  touchAction: 'none',
  userSelect: 'none',
  cursor: 'pointer',
});

export const track = style({
  position: 'relative',
  flexGrow: 1,
  height: '4px',
  background: vars.color.border,
  borderRadius: '2px',
});

export const fill = style({
  position: 'absolute',
  height: '100%',
  background: vars.color.accent,
  borderRadius: '2px',
  left: 0,
  pointerEvents: 'none',
});

export const thumb = style({
  position: 'absolute',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: '14px',
  height: '14px',
  borderRadius: '50%',
  background: vars.color.accent,
  border: `2px solid ${vars.color.bg}`,
  boxShadow: `0 0 0 1px ${vars.color.accent}`,
  outline: 'none',
  cursor: 'pointer',
  selectors: {
    '&:focus-visible': {
      boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.color.accent} 40%, transparent)`,
    },
  },
});
