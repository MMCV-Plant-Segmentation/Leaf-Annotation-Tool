import { createTheme, globalStyle } from '@vanilla-extract/css';
import { vars } from './contract.css';
import { darkValues, lightValues } from './tokens';

/**
 * Dark theme (default) — current app palette.
 * Applied to <body> by applyTheme() in index.ts.
 */
export const darkThemeClass = createTheme(vars, darkValues);

/**
 * Light theme — accessible palette.
 */
export const lightThemeClass = createTheme(vars, lightValues);

/**
 * Legacy bridge: each theme class also writes the old CSS custom-property names
 * (`--bg`, `--text`, …) so that legacy.css (prefix-wrapped under :where(.legacy))
 * continues to work without changes. One source of truth — the VE contract — two consumers.
 */
const legacyMap: Record<string, string> = {
  '--bg':      vars.color.bg,
  '--surface': vars.color.surface,
  '--border':  vars.color.border,
  '--text':    vars.color.text,
  '--muted':   vars.color.textMuted,
  '--user':    vars.color.accent,
  '--gt':      vars.status.gt,
  '--pass':    vars.status.pass,
  '--fail':    vars.status.fail,
  '--warn':    vars.status.warn,
  '--radius':  vars.radius.md,
};

for (const cls of [darkThemeClass, lightThemeClass]) {
  globalStyle(`.${cls}`, { vars: legacyMap as Record<string, string> });
}
