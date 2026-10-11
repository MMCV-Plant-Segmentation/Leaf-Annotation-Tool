/**
 * t164 — the batch merge UX is behind a whole-app ADMIN toggle, OFF by default.
 *
 * Christian (2026-10-10): merge (everything after "merge-ready") isn't finished, so hide it until
 * an admin turns it on in Admin > Settings. The merge-ready badge STAYS; only the Enter / Continue
 * merge buttons are hidden. Hiding is enough (no server-side block). Stored in the existing
 * `settings` table as MERGE_ENABLED; members read it via GET /api/global-settings.
 *
 * Each merge spec sets the flag it needs up front (the e2e server's DB is shared across specs).
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAsFreshUser } from './freshUser';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', name);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  return page.url().split('/projects/')[1].split('?')[0];
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


/** Mark every tile-complete circle done on the current image, then walk forward
 * through any further images (batch size=2 may span 1 or 2 images) doing the same. */
async function completeEveryTile(p: Page) {
  for (;;) {
    const circles = p.locator('[data-testid="tile-complete"]');
    const n = await circles.count();
    for (let i = 0; i < n; i++) {
      const c = circles.nth(i);
      if ((await c.getAttribute('fill')) !== '#16a34a') {
        await c.dispatchEvent('pointerdown');
        await expect(c).toHaveAttribute('fill', '#16a34a', { timeout: 3000 });
      }
    }
    const nextBtn = p.getByRole('button', { name: /img ›/i });
    if ((await nextBtn.count()) === 0 || (await nextBtn.isDisabled())) break;
    await nextBtn.click();
  }
}

async function openSettings(page: Page) {
  await page.goto('/admin');
  await expect(page.getByTestId('auth-username')).toBeVisible();
  await page.click('button[role=tab]:text("Settings")');
}

test('merge buttons hidden until an admin enables merge; the merge-ready badge stays @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  expect((await page.request.patch('/api/settings', { data: { MERGE_ENABLED: '0' } })).status()).toBe(200);

  // ── A one-annotator batch, every tile completed → merge-ready ──
  const pid = await createProject(page, `MergeToggle ${Date.now()}`);
  const uA = `mtogA-${Date.now()}`;
  const userA = await (await page.request.post('/api/users', { data: { username: uA } })).json() as
    { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: userA.id } });
  await importImages(page, pid);
  await confirmTiling(page, pid);
  await page.goto(`/projects/${pid}`);
  await page.locator('input[type="number"]').fill('2');
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /open canvas/i }).first().click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}$/, { timeout: 5000 });
  const canvasUrl = page.url();
  const pA = await loginAsFreshUser(browser, uA, userA.invite.token);
  await pA.goto(canvasUrl);
  await expect(pA.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await completeEveryTile(pA);

  // ── OFF (default): badge says merge-ready, but no merge buttons — for admin and member alike ──
  await page.goto(`/projects/${pid}`);
  await expect(page.getByText('merge-ready', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('enter-merge-btn')).toHaveCount(0);
  await expect(page.getByTestId('continue-merge-btn')).toHaveCount(0);
  await pA.goto(`/projects/${pid}`);
  await expect(pA.getByText('merge-ready', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(pA.getByTestId('enter-merge-btn')).toHaveCount(0);

  // ── Admin turns it on in Admin > Settings; it persists ──
  await openSettings(page);
  const box = page.getByTestId('setting-merge-enabled');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json() as
    Record<string, { value: string }>).MERGE_ENABLED?.value).toBe('1');
  await openSettings(page);
  await expect(page.getByTestId('setting-merge-enabled')).toBeChecked();

  // ── ON: the member and the admin both get Enter merge; it works ──
  await pA.goto(`/projects/${pid}`);
  await expect(pA.getByTestId('enter-merge-btn')).toBeVisible({ timeout: 5000 });
  await page.goto(`/projects/${pid}`);
  await page.getByTestId('enter-merge-btn').click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}\/merge$/, { timeout: 5000 });

  // ── OFF again: a batch already in merge loses Continue merge (fine — nobody merges yet) ──
  await openSettings(page);
  await page.getByTestId('setting-merge-enabled').uncheck();
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json() as
    Record<string, { value: string }>).MERGE_ENABLED?.value).toBe('0');
  await page.goto(`/projects/${pid}`);
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('continue-merge-btn')).toHaveCount(0);
  await expect(page.getByTestId('enter-merge-btn')).toHaveCount(0);
});
