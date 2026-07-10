/**
 * MERGE Phase 2a (frontend) — candidate objects + erasure on the shared merge viewer.
 *
 * Opus-written TDD spec (the implementer makes it pass WITHOUT editing this file). Covers the
 * user-visible 2a behaviors, wired to the 2a backends (candidate-objects + erasures):
 *  (a) The merge toolset grows to [pan, group, select, eraser].
 *  (b) The GROUPING BRUSH creates a candidate object (a CO hull) over the marks it's dragged across.
 *  (c) The ERASER marks a pooled mark erased — it stays visible but flagged (data-erased), and the
 *      erasure is RECOVERABLE/persistent (survives a reload, because it's a co_erasure toggle).
 *
 * Setup mirrors merge-mode.spec.ts: two fresh annotators seed a mark each + complete their tiles,
 * admin enters merge and acts as the merger.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;
type Tile = { x: number; y: number; w: number; h: number };

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
  expect((await anonPage.request.post(`/api/invite/${invite}`, { data: { password: pw, confirm: pw } })).ok()).toBeTruthy();
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

async function seedStroke(p: Page, pid: string, imageId: string, tile: Tile, annotator: string, quad: 1 | 3) {
  const px = tile.x + Math.floor(quad === 1 ? tile.w / 4 : (3 * tile.w) / 4);
  const py = tile.y + Math.floor(quad === 1 ? tile.h / 4 : (3 * tile.h) / 4);
  const r = await p.request.post(`/api/projects/${pid}/annotations`, {
    data: { imageId, annotator, kind: 'stroke', points: [[px, py], [px + 15, py + 15]],
      label: 'lesion', strokeWidth: 10, viewport: { x: tile.x, y: tile.y, w: tile.w, h: tile.h } },
  });
  expect(r.status()).toBe(201);
}

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

/** Drag the active tool broadly across the whole image (covers both seeded marks in tile 0). */
async function scribbleAcrossImage(page: Page) {
  const box = await page.locator('svg').first().boundingBox();
  if (!box) throw new Error('no svg');
  const x0 = box.x + box.width * 0.15, y0 = box.y + box.height * 0.15;
  const x1 = box.x + box.width * 0.85, y1 = box.y + box.height * 0.85;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 });
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

test('merge 2a: grouping brush makes a candidate object; eraser flags a mark, recoverably @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;

  // ── Setup: project, 2 annotators, images, tiling, batch, two seeded marks, enter merge ──
  const pid = await createProject(page, `MergeGroup ${Date.now()}`);
  const mk = async (u: string) => {
    const resp = await page.request.post('/api/users', { data: { username: u } });
    const user = await resp.json() as { id: number; invite: { token: string } };
    await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: user.id } });
    return user;
  };
  const uA = `grpA-${Date.now()}`, uB = `grpB-${Date.now()}`;
  const userA = await mk(uA); const userB = await mk(uB);
  await importImages(page, pid);
  await confirmTiling(page, pid);

  await page.goto(`/projects/${pid}/batches`);
  await page.locator('input[type="number"]').fill('2');
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /open canvas/i }).first().click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}$/, { timeout: 5000 });
  const canvasUrl = page.url();
  const batchId = canvasUrl.match(/batches\/([a-f0-9-]{36})/)![1];

  const pA = await loginAsFreshUser(browser, uA, userA.invite.token);
  await pA.goto(canvasUrl);
  await expect(pA.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  const cvA = await pA.request.get(`/api/batches/${batchId}?annotator=${uA}`).then((r) => r.json());
  const img0 = cvA.images[0] as { imageId: string; tiles: Tile[] };
  await seedStroke(pA, pid, img0.imageId, img0.tiles[0], uA, 1);
  await completeEveryTile(pA);

  const pB = await loginAsFreshUser(browser, uB, userB.invite.token);
  await pB.goto(canvasUrl);
  await expect(pB.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await seedStroke(pB, pid, img0.imageId, img0.tiles[0], uB, 3);
  await completeEveryTile(pB);

  await page.goto(`/projects/${pid}/batches`);
  await page.getByTestId('enter-merge-btn').click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}\/merge$/, { timeout: 5000 });
  await expect(page.getByTestId('merge-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('svg path[stroke="#0ea5e9"]')).toHaveCount(2, { timeout: 10000 });

  // ── (a) Toolset = [pan, group, select, eraser] ──────────────────────────────
  for (const t of ['tool-pan', 'tool-group', 'tool-select', 'tool-eraser']) {
    await expect(page.getByTestId(t)).toBeVisible();
  }

  // ── (b) Grouping brush over the marks creates a candidate object (a hull) ────
  await expect(page.getByTestId('candidate-object')).toHaveCount(0);
  await page.getByTestId('tool-group').click();
  await scribbleAcrossImage(page);
  await expect(page.getByTestId('candidate-object')).toHaveCount(1, { timeout: 10000 });

  // ── (c) Eraser flags a mark (still visible, data-erased) + it's recoverable/persistent ──
  await page.getByTestId('tool-eraser').click();
  await page.locator('svg path[stroke="#0ea5e9"]').first().click();
  await expect(page.locator('[data-erased="true"]')).toHaveCount(1, { timeout: 10000 });
  // Persistent (co_erasure toggle survives a reload — recovery is more than undo/redo).
  await page.reload();
  await expect(page.getByTestId('merge-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-erased="true"]')).toHaveCount(1, { timeout: 10000 });
});
