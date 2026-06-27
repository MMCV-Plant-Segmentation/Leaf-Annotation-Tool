/**
 * Public i18n API + the shared startup loader.
 *
 * One loader fetches the active locale's catalog once at boot (before the Solid
 * render and before the deferred vanilla viewers init), installs it as the
 * active catalog, and publishes `t` as a global so the vanilla viewers
 * (trainer.js, compare*.js) read the very same dictionary — mirroring the
 * existing `window._*` bridge pattern.
 *
 * The pseudo-locale is synthesized in the browser from `en` via `toPseudo`
 * (the same generator the unit tests cover), so there's a single source of
 * truth and no build step / no server-side duplication.
 */
import { t, setActiveCatalog, loadCatalog, type Catalog } from './catalog';
import { toPseudo } from './pseudo';

export { t, setActiveCatalog, loadCatalog, getActiveCatalog } from './catalog';
export { toPseudo, toPseudoString } from './pseudo';
export type { Catalog } from './catalog';

export const DEFAULT_LOCALE = 'en';

/** Resolve the locale to load: `?locale=` query override, else the default. */
export function resolveLocale(): string {
  try {
    const q = new URLSearchParams(window.location.search).get('locale');
    if (q) return q;
  } catch {
    /* no window/search (tests) → default */
  }
  return DEFAULT_LOCALE;
}

/**
 * Fetch + install the catalog for a locale. `pseudo` is generated client-side
 * from the English catalog. Always resolves (falls back to whatever is loaded)
 * so a bad locale never blocks boot.
 */
export async function installLocale(locale: string): Promise<Catalog> {
  if (locale === 'pseudo') {
    const res = await fetch(`/api/i18n/${DEFAULT_LOCALE}`).catch(() => null);
    const en = (res && res.ok ? await res.json() : {}) as Catalog;
    const pseudo = toPseudo(en);
    setActiveCatalog(pseudo);
    return pseudo;
  }
  return loadCatalog(locale);
}

/**
 * Boot the i18n system: resolve the locale, install its catalog, and expose the
 * `t()` global for the vanilla viewers. Call once, awaited, before render.
 */
export async function initI18n(): Promise<void> {
  await installLocale(resolveLocale());
  (window as unknown as { t: typeof t }).t = t;
}
