/**
 * t164: app-wide "global settings" (admin-set, readable by any logged-in user) from
 * GET /api/global-settings. Fetched once (retried after a failure) into a shared signal (a plain
 * signal, not a resource, so readers never trigger a Suspense boundary); while loading
 * (or on error) every flag reads as OFF.
 */
import { createSignal } from 'solid-js';

export type GlobalSettings = { merge_enabled: boolean };

const DEFAULTS: GlobalSettings = { merge_enabled: false };

const [settings, setSettings] = createSignal<GlobalSettings>(DEFAULTS);
let started = false;

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/global-settings');
    if (r.ok) { setSettings({ ...DEFAULTS, ...(await r.json() as Partial<GlobalSettings>) }); return; }
  } catch {
    // fall through
  }
  started = false;  // e.g. a 401 before login: stay OFF for now, retry on the next read
}

/** Re-read after an admin changes a flag, so this tab reflects it without a reload. */
export const refreshGlobalSettings = (): Promise<void> => { started = true; return load(); };

/** The shared global settings; the first call starts the (single) fetch. */
export function globalSettings(): GlobalSettings {
  if (!started) {
    started = true;
    void load();
  }
  return settings();
}

/** Whether the batch merge UX (Enter / Continue merge) is switched on. */
export const mergeEnabled = (): boolean => globalSettings().merge_enabled;
