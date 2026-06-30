/**
 * Browser e2e specs for round-2 Labmate bug fixes (#12, #13, #14).
 *
 *  P14: deleted / missing project shows a "not found" page, not infinite loading.
 *  P13: batch-size input label shows unit text ("Tiles per batch").
 *  P12: tiling save button is visible/accent-colored; dirty-state warning fires on
 *       attempted back-navigation before saving.
 */

import { test, expect, type Page } from '@playwright/test';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', name);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const url = page.url();
  return url.split('/projects/')[1].split('?')[0];
}

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

// ── #14: project-not-found ────────────────────────────────────────────────────

test('P14: non-existent project hub shows not-found, no infinite loading', async ({ page }) => {
  await page.goto('/projects/does-not-exist');
  // Not-found message appears
  await expect(page.getByText(/project not found/i)).toBeVisible({ timeout: 5000 });
  // Back link to /projects is present
  await expect(page.getByRole('link', { name: /back to projects/i })).toBeVisible();
  // Loading text must NOT persist
  await expect(page.getByText(/loading/i)).not.toBeVisible();
});

test('P14: non-existent project images screen shows not-found', async ({ page }) => {
  await page.goto('/projects/does-not-exist/images');
  await expect(page.getByText(/project not found/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: /back to projects/i })).toBeVisible();
});

test('P14: non-existent project tiling screen shows not-found', async ({ page }) => {
  await page.goto('/projects/does-not-exist/tiling');
  await expect(page.getByText(/project not found/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: /back to projects/i })).toBeVisible();
});

test('P14: non-existent project batches screen shows not-found', async ({ page }) => {
  await page.goto('/projects/does-not-exist/batches');
  await expect(page.getByText(/project not found/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: /back to projects/i })).toBeVisible();
});

// ── #13: batch-size unit label ────────────────────────────────────────────────

test('P13: batch create form shows "Tiles per batch" label', async ({ page }) => {
  const pid = await createProject(page, `BatchUnit ${Date.now()}`);
  await importImages(page, pid);
  await confirmTiling(page, pid);

  await page.goto(`/projects/${pid}/batches`);
  // Unit text is visible in the create-row label
  await expect(page.getByText(/tiles per batch/i)).toBeVisible({ timeout: 5000 });
});

// ── #12: tiling save button + dirty warning ───────────────────────────────────

test('P12: tiling save button is visible', async ({ page }) => {
  const pid = await createProject(page, `TilingSave ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);
  await expect(page.getByTestId('tiling-save-btn')).toBeVisible({ timeout: 5000 });
});

test('P12: save button click saves and shows confirmation', async ({ page }) => {
  const pid = await createProject(page, `TilingSave2 ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);
  await page.getByTestId('tiling-save-btn').click();
  await expect(page.getByTestId('save-confirm')).toBeVisible({ timeout: 5000 });
});

test('P12: navigating back after editing slider triggers unsaved-changes dialog', async ({ page }) => {
  const pid = await createProject(page, `DirtyWarn ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);
  await expect(page.getByTestId('background-slider')).toBeVisible({ timeout: 5000 });

  // Move the slider to make it dirty (SolidJS reactive signal update)
  await page.evaluate(() => {
    const slider = document.querySelector('[data-testid="background-slider"]') as HTMLInputElement;
    slider.value = '100';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Intercept the confirm dialog — dismiss (cancel) to stay on page
  let dialogSeen = false;
  page.once('dialog', async (dialog) => {
    dialogSeen = true;
    await dialog.dismiss();
  });

  // Click back (SPA navigation → useBeforeLeave fires)
  await page.getByRole('button', { name: /← Project/i }).click();

  // Dialog must have appeared and we must still be on the tiling page
  expect(dialogSeen).toBe(true);
  await expect(page).toHaveURL(/\/tiling/);
});
