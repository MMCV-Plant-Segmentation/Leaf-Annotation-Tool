/**
 * Stack-wide version identity — fetched once from `/api/version` and cached for the
 * life of the page. Both the app-shell footer and the admin Settings version card
 * read from this single shared fetch (see docs/plans/Plan — Version everything
 * (stack-wide).md).
 */

export type VersionInfo = {
  appVersion: string;
  gitSha: string;
  builtAt: string;
  schemaVersion: number | null;
};

let cached: Promise<VersionInfo | null> | null = null;

/** Fetch /api/version once per page load; subsequent callers share the same promise. */
export function fetchVersion(): Promise<VersionInfo | null> {
  if (!cached) {
    cached = fetch('/api/version')
      .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
      .catch(() => null);
  }
  return cached;
}
