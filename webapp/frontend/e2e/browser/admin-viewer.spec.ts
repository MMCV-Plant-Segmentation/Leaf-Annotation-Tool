/**
 * Admin read-only annotator viewer (BUGS #15).
 *
 * Admin opening the canvas gets a dropdown to pick which project annotator's
 * annotations to view — strictly read-only (no paint/erase/undo/redo/class-picker/
 * tile-complete-toggle). Non-admins are unchanged: no dropdown, they annotate as
 * themselves.
 *
 * Setup seeds annotations via the API directly: admin may write any annotator's
 * annotation (create_annotation's documented admin bypass — see webapp/projects.py),
 * so no browser-driven painting is needed to get fixture data onto the canvas.
 *
 * Usernames are stamped with Date.now() — this file has no @full tests, so it runs
 * under both the `fast` and `full` Playwright projects against the same server/DB
 * in one gate run; a static username would collide on the second pass.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

type Setup = { batchUrl: string; alice: string; bob: string; aliceInvite: string };

async function setupProject(page: Page, tag: string): Promise<Setup> {
  const stamp = Date.now();
  const alice = `alice-${tag}-${stamp}`;
  const bob = `bob-${tag}-${stamp}`;

  const projResp = await page.request.post('/api/projects', { data: { name: `AdminViewer ${tag} ${stamp}` } });
  expect(projResp.ok()).toBeTruthy();
  const { id: pid } = await projResp.json() as { id: string };

  const mkUser = async (username: string) => {
    const r = await page.request.post('/api/users', { data: { username } });
    expect(r.ok()).toBeTruthy();
    const u = await r.json() as { id: number; invite: { token: string } };
    const addResp = await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: u.id } });
    expect(addResp.ok()).toBeTruthy();
    return u.invite.token;
  };
  const aliceInvite = await mkUser(alice);
  await mkUser(bob);

  const importResp = await page.request.post(`/api/projects/${pid}/images/import`, { data: { path: FIXTURE_NESTED } });
  expect(importResp.ok()).toBeTruthy();
  await page.request.patch(`/api/projects/${pid}`, { data: { tiling_confirmed: true } });

  const batchResp = await page.request.post(`/api/projects/${pid}/batches`, { data: { size: 4 } });
  expect(batchResp.ok()).toBeTruthy();
  const batch = await batchResp.json() as { id: string };

  const detail = await (await page.request.get(`/api/batches/${batch.id}?annotator=${alice}`)).json() as
    { images: { imageId: string; tiles: { x: number; y: number; w: number; h: number }[] }[] };
  const img = detail.images[0];
  const tile = img.tiles[0];
  const pt = [Math.round(tile.x + tile.w / 2), Math.round(tile.y + tile.h / 2)];

  const seed = async (annotator: string) => {
    const r = await page.request.post(`/api/projects/${pid}/annotations`, {
      data: { imageId: img.imageId, annotator, kind: 'point', points: [pt] },
    });
    expect(r.ok()).toBeTruthy();
  };
  await seed(alice);      // 1 point-annotation
  await seed(bob);        // 2 point-annotations
  await seed(bob);

  return { batchUrl: `/projects/${pid}/batches/${batch.id}`, alice, bob, aliceInvite };
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

test('admin sees a roster dropdown and no paint/erase/undo/complete controls', async ({ page }) => {
  const { batchUrl } = await setupProject(page, 'ctl');
  await page.goto(batchUrl);
  const toolbar = page.getByTestId('canvas-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 10000 });

  await expect(page.getByTestId('annotator-select')).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'brush' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'eraser' })).toHaveCount(0);
  await expect(page.getByTestId('undo-btn')).toHaveCount(0);
  await expect(page.getByTestId('redo-btn')).toHaveCount(0);
  // Only the annotator picker's <select> remains — the class picker is gone too.
  await expect(toolbar.locator('select')).toHaveCount(1);

  // Tile-completion state is still shown (read-only viewer) — just not toggleable
  // (CanvasTiles gets onToggle=undefined for admin; see canvasShapes.tsx).
  await expect(page.locator('[data-testid="tile-complete"]').first()).toBeVisible({ timeout: 5000 });
});

test('picking an annotator in the dropdown shows only that annotator\'s annotations', async ({ page }) => {
  const { batchUrl, alice, bob } = await setupProject(page, 'pick');
  await page.goto(batchUrl);
  const select = page.getByTestId('annotator-select');
  await expect(select).toBeVisible({ timeout: 10000 });

  await select.selectOption(alice);
  await expect(page.locator('svg circle[r="5"]')).toHaveCount(1, { timeout: 5000 });

  await select.selectOption(bob);
  await expect(page.locator('svg circle[r="5"]')).toHaveCount(2, { timeout: 5000 });
});

test('non-admin sees no dropdown and annotates as self', async ({ page, browser }) => {
  const { batchUrl, alice, aliceInvite } = await setupProject(page, 'na');
  const alicePage = await loginAsFreshUser(browser, alice, aliceInvite);
  await alicePage.goto(batchUrl);
  const toolbar = alicePage.getByTestId('canvas-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 10000 });

  await expect(alicePage.getByTestId('annotator-picker')).toHaveCount(0);
  await expect(alicePage.getByTestId('annotator-select')).toHaveCount(0);
  await expect(toolbar).toContainText(alice);
  // Non-admin keeps full paint tooling.
  await expect(toolbar.getByRole('button', { name: 'brush' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'eraser' })).toBeVisible();
});
