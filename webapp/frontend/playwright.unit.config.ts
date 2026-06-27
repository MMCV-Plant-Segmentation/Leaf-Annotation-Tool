// Lightweight config for running unit tests only — no server, no globalSetup.
// Use: npx playwright test --config=playwright.unit.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'unit',
      testMatch: /unit\/.+\.spec\.ts/,
    },
  ],
});
