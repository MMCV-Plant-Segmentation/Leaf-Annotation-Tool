import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const pairItem = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 14px',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  cursor: 'pointer',
  transition: 'border-color 0.15s, background 0.15s',
  userSelect: 'none',
  selectors: {
    '&:hover:not([data-disabled]), &[data-highlighted]': { borderColor: vars.color.textMuted },
    '&[data-selected]': {
      borderColor: vars.color.accent,
      background: `color-mix(in srgb, ${vars.color.accent} 8%, transparent)`,
    },
  },
});

export const pairItemReplacing = style({
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
});

export const pairItemLeft = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
});
globalStyle(`${pairItemLeft} strong`, { fontSize: '0.88rem' });
globalStyle(`${pairItemLeft} span`,   { fontSize: '0.75rem', color: vars.color.textMuted });

export const pairActionBtns = style({
  display: 'flex',
  gap: '4px',
  flexShrink: 0,
  opacity: 0,
  transition: 'opacity 0.15s',
});
globalStyle(`${pairItem}:hover ${pairActionBtns}`, { opacity: 1 });

export const pairTagsRow = style({
  display: 'flex',
  gap: '4px',
  flexWrap: 'wrap',
});

export const pairEmpty = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  padding: '4px 0',
});

export const setupSub = style({
  color: vars.color.textMuted,
  fontSize: '0.9rem',
});

export const resumeInfo = style({
  fontSize: '0.82rem',
  color: vars.color.textMuted,
  background: `color-mix(in srgb, ${vars.color.accent} 7%, transparent)`,
  border: `1px solid color-mix(in srgb, ${vars.color.accent} 20%, transparent)`,
  borderRadius: vars.radius.md,
  padding: '10px 14px',
  lineHeight: 1.6,
});
