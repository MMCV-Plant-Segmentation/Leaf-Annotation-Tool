import { rmSync } from 'fs';

const FIXTURE_DIR = '/tmp/leaf-e2e-fixture'; // must match playwright.config.ts

export default async function globalTeardown() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  console.log(`[global-teardown] removed ${FIXTURE_DIR}`);
}
