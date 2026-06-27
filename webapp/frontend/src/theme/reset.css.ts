import { globalStyle } from '@vanilla-extract/css';
import { vars } from './contract.css';

/**
 * Global reset + body styles.
 * Replaces the reset/body block from the old tokens.css (deleted Phase 4).
 * The :root token block is replaced by VE theme classes (darkThemeClass / lightThemeClass).
 */

globalStyle('*, *::before, *::after', {
  boxSizing: 'border-box',
  margin: 0,
  padding: 0,
});

globalStyle('[hidden]', {
  display: 'none !important' as 'none',
});

globalStyle('body', {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  background: vars.color.bg,
  color: vars.color.text,
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});
