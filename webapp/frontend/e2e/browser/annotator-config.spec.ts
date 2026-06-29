/**
 * Annotator config redesign — behavioural browser tests.
 *
 * Covers (from the task spec):
 *  1. Creation form shows only the name field (no tiling/threshold/classes)
 *     and navigates to the hub after create.
 *  2. Fresh project: Tiling step is locked with "Import images first";
 *     Batches step locked with "Configure tiling first".
 *  3. Roster add-annotator autocompletes registered users and only enables
 *     Add for a valid selection.
 *  4. Importing a folder path makes images appear and unlocks Tiling;
 *     saving tiling settings unlocks Batches;
 *     after a batch is created the tile-size control is disabled. (@full)
 *  5. Canvas "open as" lists the project's registered roster.
 *
 * The fixture server reads the seeded fixture dir (HT_E2E_FIXTURE_DIR; default
 * /tmp/leaf-e2e-fixture). The seed creates a "nested-images" dir for the recursive import test.
 */

import { test, expect, type Page } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────────

async function login(page: Page) {
  // Use the pre-saved auth state; no manual login needed.
  await page.goto('/projects');
  await expect(page.getByTestId('auth-username')).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', name);
  await page.click('button:text("Create project")');
  // Should navigate to /projects/:id after create
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const url = page.url();
  return url.split('/projects/')[1].split('?')[0];
}

// Server-side import path. The concurrency-safe gate seeds into a per-run temp dir and
// exports it via HT_E2E_FIXTURE_DIR; fall back to the fixed path for a plain test run.
const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

async function importImages(page: Page, pid: string) {
  await page.goto(`/projects/${pid}/images`);
  await page.fill('[data-testid="import-path"]', FIXTURE_NESTED);
  await page.click('button:text("Import")');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
}

async function confirmTiling(page: Page, pid: string) {
  await page.goto(`/projects/${pid}/tiling`);
  await page.getByRole('button', { name: /save.*default/i }).click();
  await expect(page.getByRole('button', { name: /save.*default/i })).toBeEnabled({ timeout: 5000 });
}


// ── 1. Creation form: name only ────────────────────────────────────────────────

test('creation form shows only the name field', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.locator('form')).toBeVisible();
  // Name field present (the single text input in the form)
  await expect(page.locator('form input[type="text"]')).toHaveCount(1);
  // Tile size and threshold inputs NOT present in the form
  await expect(page.locator('form input[type="number"]')).toHaveCount(0);
  await expect(page.getByText('Black threshold')).not.toBeVisible();
  await expect(page.getByText('Classes', { exact: false })).not.toBeVisible();
});

test('creating a project navigates to the hub', async ({ page }) => {
  const name = `Hub test ${Date.now()}`;
  const pid = await createProject(page, name);
  expect(pid).toMatch(/[a-f0-9-]{36}/);
  // Hub should show the project name
  await expect(page.getByText(name)).toBeVisible();
});


// ── 2. Dependency locks on a fresh project ─────────────────────────────────────

test('fresh project: Tiling locked "Import images first"', async ({ page }) => {
  const pid = await createProject(page, `Fresh ${Date.now()}`);
  await page.goto(`/projects/${pid}`);
  // Tiling section should show a lock message
  await expect(page.getByText(/import images first/i)).toBeVisible();
});

test('fresh project: Batches locked "Configure tiling first"', async ({ page }) => {
  const pid = await createProject(page, `Fresh2 ${Date.now()}`);
  await page.goto(`/projects/${pid}`);
  await expect(page.getByText(/configure tiling first/i)).toBeVisible();
});


// ── 3. Roster: registered-user autocomplete ────────────────────────────────────

test('roster: autocomplete appears and Add is disabled with no selection', async ({ page }) => {
  const pid = await createProject(page, `Roster ${Date.now()}`);
  await page.goto(`/projects/${pid}`);
  // Find the roster autocomplete input
  const rosterInput = page.getByPlaceholder(/search user/i).or(
    page.locator('[data-testid="roster-search"]')
  );
  await expect(rosterInput).toBeVisible();
  // Add button disabled when input is empty
  const addBtn = page.getByRole('button', { name: /^add$/i });
  await expect(addBtn).toBeDisabled();
});

test('roster: typing shows matching users and Add enables on valid selection', async ({ page }) => {
  const pid = await createProject(page, `Roster2 ${Date.now()}`);
  await page.goto(`/projects/${pid}`);

  const rosterInput = page.getByPlaceholder(/search user/i).or(
    page.locator('[data-testid="roster-search"]')
  );
  await rosterInput.fill('admin');
  // Dropdown suggestion should appear
  await expect(page.getByRole('option', { name: 'admin' }).or(
    page.locator('[data-testid="roster-option"]').filter({ hasText: 'admin' })
  )).toBeVisible({ timeout: 3000 });

  // Click the suggestion to select it
  await page.getByRole('option', { name: 'admin' }).or(
    page.locator('[data-testid="roster-option"]').filter({ hasText: 'admin' })
  ).click();

  // Add button should now be enabled
  const addBtn = page.getByRole('button', { name: /^add$/i });
  await expect(addBtn).toBeEnabled();
});


// ── 4. Import → tiling unlock → tiling save → batches unlock (across sub-routes) ─

test('importing images unlocks the Tiling hub card', async ({ page }) => {
  const pid = await createProject(page, `Import ${Date.now()}`);

  // Fresh hub: tiling card is locked
  await page.goto(`/projects/${pid}`);
  await expect(page.getByTestId('card-tiling-locked')).toBeVisible();

  await importImages(page, pid);

  // Back on the hub the tiling card is now an active link (no longer locked)
  await page.goto(`/projects/${pid}`);
  await expect(page.getByTestId('card-tiling')).toBeVisible();
  await expect(page.getByTestId('card-tiling-locked')).toHaveCount(0);
});

test('saving tiling settings unlocks the Batches hub card', async ({ page }) => {
  const pid = await createProject(page, `Tiling ${Date.now()}`);
  await importImages(page, pid);

  // Batches still locked before tiling is confirmed
  await page.goto(`/projects/${pid}`);
  await expect(page.getByTestId('card-batches-locked')).toBeVisible();

  await confirmTiling(page, pid);

  // Now the batches card is active
  await page.goto(`/projects/${pid}`);
  await expect(page.getByTestId('card-batches')).toBeVisible();
  await expect(page.getByTestId('card-batches-locked')).toHaveCount(0);
});

test('tile-size control disabled after batch created @full', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'full') return;

  const pid = await createProject(page, `TileLock ${Date.now()}`);
  await importImages(page, pid);
  await confirmTiling(page, pid);

  // Create a batch on the batches route
  await page.goto(`/projects/${pid}/batches`);
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });

  // Tile size input on the tiling route is now disabled
  await page.goto(`/projects/${pid}/tiling`);
  await expect(page.getByTestId('tile-size-input')).toBeDisabled();
});


// ── 5. Canvas "open as" lists registered roster ───────────────────────────────

test('canvas open-as selector lists registered roster users', async ({ page }) => {
  const pid = await createProject(page, `Canvas ${Date.now()}`);

  // Add admin to roster via autocomplete (on the hub)
  await page.goto(`/projects/${pid}`);
  await page.fill('[data-testid="roster-search"]', 'admin');
  await page.getByRole('option', { name: 'admin' }).click();
  await page.getByRole('button', { name: /^add$/i }).click();
  await expect(page.getByRole('button', { name: /remove/i })).toBeVisible({ timeout: 3000 });

  await importImages(page, pid);
  await confirmTiling(page, pid);

  // Create batch on the batches route
  await page.goto(`/projects/${pid}/batches`);
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });

  // "Open as" selector should list the registered roster
  const openAsSelect = page.getByTestId('open-as');
  await expect(openAsSelect).toBeVisible();
  await expect(openAsSelect.locator('option', { hasText: 'admin' })).toHaveCount(1);
});


// ── 6. Browser upload flow ────────────────────────────────────────────────────

const FIXTURE_FLAT = `${FIXTURE_DIR}/flat-images`;

test('upload via file picker shows per-file progress and final count', async ({ page }) => {
  const pid = await createProject(page, `Upload ${Date.now()}`);
  await page.goto(`/projects/${pid}/images`);

  const files = [
    `${FIXTURE_FLAT}/upload0.png`,
    `${FIXTURE_FLAT}/upload1.png`,
    `${FIXTURE_FLAT}/upload2.png`,
  ];

  await page.getByTestId('import-files').setInputFiles(files);
  await page.getByTestId('upload-btn').click();

  // Progress label shows 3 / 3 once complete
  await expect(page.getByTestId('import-progress-label')).toContainText('3', { timeout: 15000 });
  // Summary appears with imported count
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText('3');
});

test('re-uploading same files skips them (dedup)', async ({ page }) => {
  const pid = await createProject(page, `Dedup ${Date.now()}`);
  await page.goto(`/projects/${pid}/images`);

  const files = [
    `${FIXTURE_FLAT}/upload0.png`,
    `${FIXTURE_FLAT}/upload1.png`,
  ];

  // First upload
  await page.getByTestId('import-files').setInputFiles(files);
  await page.getByTestId('upload-btn').click();
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText('Imported 2');

  // Second upload of same files — summary should report skipped
  await page.getByTestId('import-files').setInputFiles(files);
  await page.getByTestId('upload-btn').click();
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText('skipped 2');
});
