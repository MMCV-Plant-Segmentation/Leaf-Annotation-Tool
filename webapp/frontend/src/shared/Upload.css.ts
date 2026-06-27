import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

export const uploadFileRow = style({
  display: 'flex',
  gap: '8px',
});

export const uploadFileBtn = style({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '7px 8px',
  background: vars.color.bg,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  cursor: 'pointer',
  fontSize: '0.75rem',
  color: vars.color.textMuted,
  transition: 'border-color 0.15s, color 0.15s',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  maxWidth: '50%',
  selectors: {
    '&:hover': { borderColor: vars.color.textMuted, color: vars.color.text },
  },
});
globalStyle(`${uploadFileBtn} input[type="file"]`, { display: 'none' });

export const uploadStatus = style({
  fontSize: '0.78rem',
  color: vars.color.textMuted,
});

export const replaceFileHint = style({
  fontStyle: 'italic',
  opacity: 0.7,
});
