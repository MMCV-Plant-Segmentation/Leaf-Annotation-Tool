/**
 * Shared i18n catalog — the single source of truth for both the Solid layer and
 * the vanilla viewers. Pure and testable: no framework imports, no DOM.
 *
 * Design (see docs/Plan — i18n string extraction.md):
 *  - The active catalog is a flat map of namespaced keys → strings.
 *  - `t(key, vars?)` looks a key up, interpolating `{var}` placeholders.
 *  - Missing key → return the key itself (never blank, never throws).
 *  - `loadCatalog(locale)` fetches `/api/i18n/<locale>` and installs it.
 */

export type Catalog = Record<string, string>;

let active: Catalog = {};

/** Install a catalog as the active one (used by the loader and by tests). */
export function setActiveCatalog(map: Catalog): void {
  active = map ?? {};
}

/** Read the currently-active catalog (mostly for the pseudo generator / debugging). */
export function getActiveCatalog(): Catalog {
  return active;
}

/**
 * Translate a key. Interpolates `{name}` style placeholders from `vars`.
 * Missing key → the key string itself, so a typo degrades visibly instead of
 * blanking the UI. Unmatched placeholders are left intact.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = Object.prototype.hasOwnProperty.call(active, key) ? active[key] : key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Fetch a locale's catalog from the backend and install it as active.
 * The backend falls back to the bundled default / English for unknown locales,
 * so this resolves to *some* catalog as long as the server is up. On network
 * failure we leave the previous catalog in place and resolve to it.
 */
export async function loadCatalog(locale: string): Promise<Catalog> {
  try {
    const res = await fetch(`/api/i18n/${encodeURIComponent(locale)}`);
    if (res.ok) {
      const map = (await res.json()) as Catalog;
      setActiveCatalog(map);
    }
  } catch {
    // Network error: keep whatever catalog we already have.
  }
  return active;
}
