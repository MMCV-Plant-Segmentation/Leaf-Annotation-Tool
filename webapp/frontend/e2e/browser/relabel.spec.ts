/**
 * Compound labels Phase 2b — re-label a selected lesion via the paint drop-down.
 *
 * Covers: open the annotator canvas → paint a lesion → select it (select tool) →
 * the SAME drop-down used to paint auto-syncs to show the lesion's current label →
 * picking another compound re-labels + recolors the lesion on the canvas → the
 * relabel survives a reload → deselecting restores the drop-down to the last
 * MANUALLY-chosen paint label (not left showing the just-picked relabel value).
 *
 * Project setup mirrors annotator-config.spec.ts's canvas fixtures: admin creates the
 * project + roster + batch via the UI/API, then a fresh REAL (non-admin) user does the
 * actual canvas interaction (BUGS #15: admin's canvas is a read-only viewer with no
 * class picker, so relabelling can only be exercised as a genuine annotator).
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

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

async function loginAsFreshUser(browser: Browser, username: string, invite: string): Promise<Page> {
  const pw = 'TestPass99!';
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(`/api/invite/${invite}`, { data: { password: pw, confirm: pw } });
  expect(acceptResp.ok()).toBeTruthy();
  await anonCtx.close();

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.fill('#login-username', username);
  await p.fill('#login-password', pw);
  await p.click('button[type=submit]');
  await expect(p.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  return p;
}

/** Admin sets up a project with two compounds ('ok', 'danger') + a real annotator
 * roster member, then hands off to that annotator's own logged-in page for the
 * canvas interaction. Returns the annotator's page + the compounds' colours (fetched
 * from the API so assertions don't hardcode the default palette). */
async function setupRelabelCanvas(page: Page, browser: Browser):
  Promise<{ p: Page; okColor: string; dangerColor: string }> {
  const pid = await createProject(page, `Relabel ${Date.now()}`);
  await page.request.patch(`/api/projects/${pid}`, { data: { classes: ['ok', 'danger'] } });

  const username = `relabel-${Date.now()}`;
  const createResp = await page.request.post('/api/users', { data: { username } });
  const user = await createResp.json() as { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: user.id } });

  await importImages(page, pid);
  await confirmTiling(page, pid);

  await page.goto(`/projects/${pid}/batches`);
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /open canvas/i }).first().click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}/, { timeout: 5000 });
  const canvasUrl = page.url();

  const proj = await (await page.request.get(`/api/projects/${pid}`)).json() as
    { classes: { name: string; color: string }[] };
  const okColor = proj.classes.find((c) => c.name === 'ok')!.color.toLowerCase();
  const dangerColor = proj.classes.find((c) => c.name === 'danger')!.color.toLowerCase();

  const p = await loginAsFreshUser(browser, username, user.invite.token);
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  return { p, okColor, dangerColor };
}

test('select a painted lesion, relabel via the paint drop-down, recolor, restore on deselect', async ({ page, browser }) => {
  const { p, okColor, dangerColor } = await setupRelabelCanvas(page, browser);
  const toolbar = p.getByTestId('canvas-toolbar');
  const classSelect = toolbar.locator('select');

  // Paint a stroke labelled 'ok' (the drop-down defaults to the first compound).
  await expect(classSelect).toHaveValue('ok', { timeout: 5000 });
  await p.getByTestId('tool-brush').click();
  p.on('dialog', (d) => void d.dismiss());
  const canvasSvg = p.locator('svg').first();
  await expect(canvasSvg).toBeVisible({ timeout: 10000 });
  const box = await canvasSvg.boundingBox();
  const cx = (box?.x ?? 200) + (box?.width ?? 200) / 2;
  const cy = (box?.y ?? 200) + (box?.height ?? 200) / 2;
  await p.mouse.move(cx - 15, cy - 15);
  await p.mouse.down();
  for (let i = 1; i <= 5; i++) await p.mouse.move(cx - 15 + i * 6, cy - 15 + i * 4);
  await p.mouse.up();

  const lesion = p.locator('svg path[stroke]').first();
  await expect(lesion).toBeVisible({ timeout: 5000 });
  await expect(lesion).toHaveAttribute('stroke', new RegExp(okColor, 'i'));

  // Select it: switch to the select tool, click back on the painted spot.
  await p.getByTestId('tool-select').click();
  await p.mouse.click(cx - 15, cy - 15);

  // Drop-down auto-syncs to the selected lesion's current label ('ok').
  await expect(classSelect).toHaveValue('ok');

  // Pick 'danger' in the SAME drop-down → relabels + recolors the selected lesion.
  await classSelect.selectOption('danger');
  await expect(lesion).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Persists across a reload.
  await p.reload();
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(p.locator('svg path[stroke]').first()).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Deselect (Escape) → drop-down restores to the last MANUALLY-chosen paint label
  // ('ok'), not left showing the relabel pick.
  await p.keyboard.press('Escape');
  await expect(classSelect).toHaveValue('ok');
});
