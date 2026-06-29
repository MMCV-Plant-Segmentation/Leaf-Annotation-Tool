import { chromium } from '@playwright/test';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR  = path.join(__dirname, '..', '..'); // webapp/frontend/e2e/ → webapp/
const SEED_SCRIPT = path.join(__dirname, 'fixtures', 'seed.py');
const FIXTURE_DIR = '/tmp/leaf-e2e-fixture'; // must match playwright.config.ts
const AUTH_FILE   = path.join(__dirname, '.auth.json');
const ADMIN_PW    = 'e2e-admin-pw'; // must match playwright.config.ts webServer env
const TEST_PORT   = process.env.TEST_PORT ?? '5000'; // gate may override via env

export default async function globalSetup() {
  const result = spawnSync(
    'uv', ['run', 'python3', SEED_SCRIPT, FIXTURE_DIR],
    { cwd: WEBAPP_DIR, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`seed.py failed (exit ${result.status})`);
  }
  console.log(`[global-setup] fixture seeded at ${FIXTURE_DIR}`);

  // Log in via API and save session cookie for all tests.
  // The webServer must already be up (Playwright starts it before globalSetup).
  const browser = await chromium.launch();
  const ctx     = await browser.newContext();
  const res     = await ctx.request.post(`http://localhost:${TEST_PORT}/api/login`, {
    data: { username: 'admin', password: ADMIN_PW },
  });
  if (!res.ok()) throw new Error(`[global-setup] login failed: ${res.status()}`);
  await ctx.storageState({ path: AUTH_FILE });
  await browser.close();
  console.log(`[global-setup] auth saved to ${AUTH_FILE}`);
}
