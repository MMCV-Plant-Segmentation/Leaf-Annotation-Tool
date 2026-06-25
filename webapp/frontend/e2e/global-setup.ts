import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR  = path.join(__dirname, '..', '..'); // webapp/frontend/e2e/ → webapp/
const SEED_SCRIPT = path.join(__dirname, 'fixtures', 'seed.py');
const FIXTURE_DIR = '/tmp/leaf-e2e-fixture'; // must match playwright.config.ts

export default async function globalSetup() {
  const result = spawnSync(
    'uv', ['run', 'python3', SEED_SCRIPT, FIXTURE_DIR],
    { cwd: WEBAPP_DIR, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`seed.py failed (exit ${result.status})`);
  }
  console.log(`[global-setup] fixture seeded at ${FIXTURE_DIR}`);
}
