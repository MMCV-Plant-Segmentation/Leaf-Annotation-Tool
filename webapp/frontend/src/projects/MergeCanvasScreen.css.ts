import { style } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// MERGE Phase 1: a small pill flagging "you're looking at a blinded pooled view" so a
// merger never mistakes it for their own annotate-as-yourself canvas.
export const blindBadge = style({
  fontSize: '0.75rem',
  fontWeight: 600,
  color: vars.color.accentText,
  background: vars.color.accent,
  padding: '0.15rem 0.5rem',
  borderRadius: vars.radius.sm,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
});

// MERGE Phase 2a: the merge selection action bar (Group / Ungroup / Dissolve). Shown
// only when a mark or CO is selected (right-click context menu is deferred, BUGS #35).
export const actionBar = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.35rem 0.5rem',
  background: vars.color.surface,
  borderTop: `1px solid ${vars.color.border}`,
  borderBottom: `1px solid ${vars.color.border}`,
});
