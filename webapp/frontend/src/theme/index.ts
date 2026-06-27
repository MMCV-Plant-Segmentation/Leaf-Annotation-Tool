/**
 * Public API for the theme system.
 * Components import from here, not from individual theme files.
 */
export { vars } from './contract.css';
export { darkThemeClass, lightThemeClass } from './themes.css';

// Side-effect: apply global reset styles when bundled.
import './reset.css';

export const THEME_STORAGE_KEY = 'leaf-theme';

/**
 * Read persisted preference (or undefined if none saved).
 */
export function savedTheme(): 'dark' | 'light' | null {
  const v = localStorage.getItem(THEME_STORAGE_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}

/**
 * Switch <body> from one theme class to another.
 */
export function applyTheme(remove: string, add: string): void {
  document.body.classList.remove(remove);
  document.body.classList.add(add);
}

/**
 * Apply the saved theme at boot, defaulting to DARK when no preference is saved.
 * Called once from mount.tsx. The app is dark-by-default; light is opt-in via the
 * toggle (which persists to localStorage). We deliberately do NOT follow
 * prefers-color-scheme — an unintended OS-driven light mode was the original bug.
 */
export function initTheme(darkCls: string, lightCls: string): void {
  const pref = savedTheme();
  document.body.classList.add(pref === 'light' ? lightCls : darkCls);
}
