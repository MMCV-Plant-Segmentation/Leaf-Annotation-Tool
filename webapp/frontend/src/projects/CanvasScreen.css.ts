import { style, globalStyle } from '@vanilla-extract/css';
import { vars } from '../theme/contract.css';

// Strip legacy .setup-card chrome when the canvas screen is mounted — the
// annotation tool needs the full viewport, not the narrow home-screen card.
// Specificity: 0,2,0 (class + :has attribute), same as the project-screen rule
// in legacy.css; app.bundle.css loads after legacy.css so this wins the cascade.
globalStyle('.setup-card:has([data-screen="canvas"])', {
  width: '100%',
  height: '100%',
  padding: '0',
  border: 'none',
  borderRadius: '0',
  background: 'none',
  gap: '0',
  margin: '0',
});

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

export const classPick = style({
  fontSize: '0.82rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
});

// BUG 28b: the native <select> dropdown caret overlaps the selected annotator name.
// Right-padding the select reserves space for the arrow so text never sits under it.
// Still applies to the ANNOTATOR picker (AnnotatorPicker.tsx), which stays a native
// <select> — the CLASS picker was replaced with LabelPicker.tsx (colour-coded rows,
// which a native <select>'s OS-drawn <option> chrome can't do reliably).
globalStyle(`${classPick} select`, {
  padding: '0.3rem 1.5rem 0.3rem 0.4rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '6px',
  background: vars.color.surface,
  color: vars.color.text,
  fontSize: '0.82rem',
});

export const stage = style({
  position: 'relative',  // anchors the admin viewport-heatmap control panel
  flex: '1 1 auto',
  minHeight: 0,
  background: vars.color.bg,
  borderRadius: vars.radius.md,
  overflow: 'hidden',
});

export const svg = style({
  // Fill the entire stage so no inner clipping rectangle restricts the drawable area.
  width: '100%',
  height: '100%',
  display: 'block',
  touchAction: 'none',
  background: vars.color.bg,
});

export const panning = style({
  cursor: 'grab',
});

export const spacePanning = style({
  cursor: 'move',
});

export const check = style({
  cursor: 'pointer',
});

export const erasing = style({
  cursor: 'cell',
});

export const sizeLabel = style({
  fontSize: '0.82rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
});

export const sizeSlider = style({
  width: '72px',
  cursor: 'pointer',
  accentColor: vars.color.accent,
});

export const sizeNumberInput = style({
  width: '52px',
  padding: '0.15rem 0.3rem',
  border: `1px solid ${vars.color.border}`,
  borderRadius: '4px',
  background: vars.color.surface,
  color: vars.color.text,
  fontSize: '0.8rem',
});

export const legend = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
  padding: '0.3rem 0.6rem',
  borderTop: `1px solid ${vars.color.border}`,
  background: vars.color.surface,
  fontSize: '0.8rem',
});

export const legendTitle = style({
  color: vars.color.textMuted,
  fontWeight: 600,
});

export const legendItem = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  color: vars.color.text,
});

export const legendSwatch = style({
  display: 'inline-block',
  width: '12px',
  height: '12px',
  borderRadius: '3px',
  border: `1px solid ${vars.color.border}`,
});
