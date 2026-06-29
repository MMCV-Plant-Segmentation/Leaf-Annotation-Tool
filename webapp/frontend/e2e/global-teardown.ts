import { rmSync } from 'fs';

// Same env override + fallback as playwright.config.ts / global-setup.ts. Under the gate
// this is a per-run temp dir; the gate also cleans its run dir, so a double-remove is fine.
const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';

export default async function globalTeardown() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  console.log(`[global-teardown] removed ${FIXTURE_DIR}`);
}
