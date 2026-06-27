import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const kSlider = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  touchAction: 'none',
  userSelect: 'none',
});

export const kTrack = style({
  position: 'relative',
  flexGrow: 1,
  height: '4px',
  borderRadius: '2px',
  // background set dynamically via kSliderBg()
});

export const kThumb = style({
  position: 'absolute',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: '14px',
  height: '14px',
  borderRadius: '50%',
  background: vars.color.accent,
  border: 'none',
  boxShadow: `0 1px 3px color-mix(in srgb, black 40%, transparent)`,
  outline: 'none',
  cursor: 'pointer',
  selectors: {
    '&:focus-visible': {
      boxShadow: `0 0 0 2px ${vars.color.accent}`,
    },
  },
});

export const kOverlapGrid = style({
  display: 'grid',
  gridTemplateColumns: '28px 1fr',
  gap: '0 4px',
  marginTop: '4px',
});

export const kOverlapLeft = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
});

export const kOverlapRight = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
});

export const kSliderWrapper = style({
  height: '18px',
  display: 'flex',
  alignItems: 'center',
});

export const kBdSpacer = style({
  height: '18px',
  flexShrink: 0,
});

export const kBdLeftLabel = style({
  height: '4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  fontSize: '0.62rem',
  color: vars.color.textMuted,
});
