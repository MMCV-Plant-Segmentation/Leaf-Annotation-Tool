import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixture dir + storageState path: globalSetup seeds/writes them, webServer + tests read them.
// The concurrency-safe gate (scripts/gate.py) overrides both via env so parallel runs use
// per-run temp dirs; a plain `npx playwright test` falls back to the fixed paths below.
const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const STATE_FILE = process.env.HT_E2E_STATE_FILE ?? path.join(__dirname, 'e2e', '.auth.json');

// The gate runs its server on an ephemeral port (TEST_PORT). Normal dev use defaults to 5000.
const TEST_PORT = process.env.TEST_PORT ?? '5000';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup:    './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${TEST_PORT}`,
    // Global login state: globalSetup logs in and saves the session cookie here.
    storageState: STATE_FILE,
  },
  projects: [
    {
      // Browserless pure-logic specs. No `page` fixture → no browser launched.
      name: 'unit',
      testMatch: /unit\/.+\.spec\.ts/,
    },
    {
      // Real browser, behaviour/reactivity assertions. No computed-style checks.
      name: 'fast',
      testMatch: /browser\/.+\.spec\.ts/,
      grepInvert: /@full/,
    },
    {
      // fast + computed-style (@full-tagged) + CSS quarantine guard.
      name: 'full',
      testMatch: /browser\/.+\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'uv run leaf-annotation',
    cwd: path.join(__dirname, '..'),
    url: `http://localhost:${TEST_PORT}`,
    // Point the server at the fixture dir regardless of when it starts.
    // globalSetup seeds into the same path before tests begin.
    env: {
      HT_DATA_DIR:    FIXTURE_DIR,
      SECRET_KEY:     'e2e-test-secret-key-not-for-production',
      ADMIN_PASSWORD: 'e2e-admin-pw',
    },
    // Locally reuse a running server; in CI always start fresh.
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
