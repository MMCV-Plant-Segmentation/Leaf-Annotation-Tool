import { createThemeContract } from '@vanilla-extract/css';

/**
 * Single typed contract: defines the token *names* (shape) with null values.
 * Actual values live in tokens.ts (darkValues / lightValues).
 * Components import `vars` and reference tokens as `vars.color.bg` etc.
 */
export const vars = createThemeContract({
  color: {
    bg:           null,
    surface:      null,
    surfaceRaised:null,
    border:       null,
    text:         null,
    textMuted:    null,
    accent:       null,
    accentText:   null,
    dangerBg:     null,
    danger:       null,
    infoBg:       null,
  },
  status: {
    pass: null,
    fail: null,
    warn: null,
    gt:   null,
  },
  radius: {
    sm: null,
    md: null,
  },
  space: {
    xs: null,
    sm: null,
    md: null,
    lg: null,
    xl: null,
  },
});
