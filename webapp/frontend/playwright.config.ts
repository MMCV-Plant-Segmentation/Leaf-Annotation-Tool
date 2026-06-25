import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixed fixture dir: globalSetup seeds into it, webServer uses it.
// Flask is connection-per-request, so rows inserted by seed (after startup) are visible to tests.
const FIXTURE_DIR = '/tmp/leaf-e2e-fixture';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup:    './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:5000',
    // Pre-seed the byline so screens open without the mandatory first-load modal.
    // Tests that exercise the byline flow clear this via browser.newContext().
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:5000',
        localStorage: [{ name: 'lesion-user', value: 'E2EBot' }],
      }],
    },
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
    url: 'http://localhost:5000',
    // Point the server at the fixture dir regardless of when it starts.
    // globalSetup seeds into the same path before tests begin.
    env: { HT_DATA_DIR: FIXTURE_DIR },
    // Locally reuse a running server; in CI always start fresh.
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
