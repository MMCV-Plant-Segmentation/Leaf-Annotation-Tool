import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5000',
    // Seed the byline so screens render without the first-load modal blocking them.
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:5000',
        localStorage: [{ name: 'lesion-user', value: 'SmokeBot' }],
      }],
    },
  },
  projects: [
    { name: 'smoke', testMatch: /smoke\/.+\.spec\.ts/ },
  ],
  webServer: {
    command: 'uv run app.py',
    cwd: path.join(__dirname, '..'),
    url: 'http://localhost:5000',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
