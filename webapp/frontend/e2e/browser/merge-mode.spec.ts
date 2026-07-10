/**
 * MERGE Phase 1 — batch-completion gate + the read-only blind pooled viewer.
 *
 * Covers (from the task spec):
 *  (a) The Merge button is ABSENT on the batches list until every annotator has
 *      completed every tile in the batch, then appears.
 *  (b) Entering merge renders pooled marks from >1 annotator, all one colour
 *      and outline-only (blind — fill="none").
 *  (c) Merge shares CanvasScreen's nav model (whole image, tiles overlaid,
 *      navigate IMAGE-by-image) — the old tile-by-tile counter/prev/next is gone.
 *  (d) The merge toolbar only enables the `pan` tool (no select/brush/eraser) and
 *      the view is read-only (no paint gesture effect).
 *
 * Two fresh (non-admin) annotators each paint one stroke and mark every one of
 * their assigned tiles complete — mirrors annotator-config.spec.ts / relabel.spec.ts's
 * setup pattern (admin creates the project/roster/batch, a genuine annotator identity
 * does the canvas interaction).
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

/** Paint one brush stroke near the canvas centre (± offsetX so two annotators' strokes
 * land at visibly distinct spots on the same tile). */
type Tile = { x: number; y: number; w: number; h: number };

/** Seed a stroke via the API placed INSIDE `tile` (quadrant 1 or 3, so two annotators' marks are
 * distinguishable) — this reliably creates the `annotation_tile` link the pooled merge read
 * requires, unlike screen-space painting where the image-coordinate geometry may miss the tile. */
async function seedStroke(p: Page, pid: string, imageId: string, tile: Tile, annotator: string, quad: 1 | 3) {
  const px = tile.x + Math.floor(quad === 1 ? tile.w / 4 : (3 * tile.w) / 4);
  const py = tile.y + Math.floor(quad === 1 ? tile.h / 4 : (3 * tile.h) / 4);
  const r = await p.request.post(`/api/projects/${pid}/annotations`, {
    data: {
      imageId, annotator, kind: 'stroke', points: [[px, py], [px + 15, py + 15]],
      label: 'lesion', strokeWidth: 10, viewport: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    },
  });
  expect(r.status()).toBe(201);
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

test('merge gate button + blind pooled read-only viewer @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;

  // ── Setup: project, 2-annotator roster, images, tiling, a 2-tile batch ──────
  const pid = await createProject(page, `MergeMode ${Date.now()}`);

  const uA = `mergeA-${Date.now()}`;
  const respA = await page.request.post('/api/users', { data: { username: uA } });
  const userA = await respA.json() as { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: userA.id } });

  const uB = `mergeB-${Date.now()}`;
  const respB = await page.request.post('/api/users', { data: { username: uB } });
  const userB = await respB.json() as { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: userB.id } });

  await importImages(page, pid);
  await confirmTiling(page, pid);

  await page.goto(`/projects/${pid}/batches`);
  await page.locator('input[type="number"]').fill('2');
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });

  // ── (a) Merge button ABSENT before any tile is completed ────────────────────
  await expect(page.getByTestId('enter-merge-btn')).toHaveCount(0);
  await expect(page.getByTestId('continue-merge-btn')).toHaveCount(0);

  await page.getByRole('button', { name: /open canvas/i }).first().click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}$/, { timeout: 5000 });
  const canvasUrl = page.url();

  // ── Annotator A seeds a mark (in tile 0) + completes every assigned tile ─────
  const batchId = canvasUrl.match(/batches\/([a-f0-9-]{36})/)![1];
  const pA = await loginAsFreshUser(browser, uA, userA.invite.token);
  await pA.goto(canvasUrl);
  await expect(pA.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  const cvA = await pA.request.get(`/api/batches/${batchId}?annotator=${uA}`).then((r) => r.json());
  const imageCount = (cvA.images as unknown[]).length;
  const img0 = cvA.images[0] as { imageId: string; tiles: Tile[] };
  const tile0 = img0.tiles[0];
  await seedStroke(pA, pid, img0.imageId, tile0, uA, 1);
  await completeEveryTile(pA);

  // ── Merge button still absent: B has not completed anything yet ─────────────
  await page.goto(`/projects/${pid}/batches`);
  await expect(page.getByTestId('enter-merge-btn')).toHaveCount(0);

  // ── Annotator B seeds a distinguishably-placed mark (same tile 0) + completes ─
  const pB = await loginAsFreshUser(browser, uB, userB.invite.token);
  await pB.goto(canvasUrl);
  await expect(pB.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await seedStroke(pB, pid, img0.imageId, tile0, uB, 3);
  await completeEveryTile(pB);

  // ── (a) Merge button now VISIBLE — every annotator_tile is completed ────────
  await page.goto(`/projects/${pid}/batches`);
  const mergeBtn = page.getByTestId('enter-merge-btn');
  await expect(mergeBtn).toBeVisible({ timeout: 5000 });
  await mergeBtn.click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}\/merge$/, { timeout: 5000 });

  // ── (b) Pooled marks from BOTH annotators, one colour, outline-only (blind) ─
  await expect(page.getByTestId('merge-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('merge-blind-badge')).toBeVisible();
  const marks = page.locator('svg path[stroke]');
  await expect(marks).toHaveCount(2, { timeout: 10000 });
  for (const i of [0, 1]) {
    await expect(marks.nth(i)).toHaveAttribute('stroke', '#0ea5e9');
    await expect(marks.nth(i)).toHaveAttribute('fill', 'none');
  }

  // ── (c) Shared IMAGE nav model — tile-by-tile counter/prev/next is gone. The
  // batch's images (whole image, tiles overlaid) are what's paged; a 2-tile batch
  // may still be a single image (both tiles on one image) or span two, so branch
  // on how many images the batch actually has (see `imageCount`, captured above).
  if (imageCount > 1) {
    await expect(page.getByTestId('img-prev')).toBeDisabled();
    await expect(page.getByTestId('img-next')).toBeEnabled();

    await page.getByTestId('img-next').click();
    await expect(page.getByTestId('img-next')).toBeDisabled();
    await expect(page.getByTestId('img-prev')).toBeEnabled();

    await page.getByTestId('img-prev').click();
    await expect(page.getByTestId('img-prev')).toBeDisabled();
  } else {
    // Single-image batch: the shared toolbar only shows image nav when there's
    // more than one image (imgCount > 1) — same gate CanvasScreen uses.
    await expect(page.getByTestId('img-prev')).toHaveCount(0);
    await expect(page.getByTestId('img-next')).toHaveCount(0);
  }

  // ── (d) The merge toolset is present and the pooled marks stay BLIND. (Phase 2a made
  // the merge view no longer read-only/pan-only — it has group/select/eraser; the full
  // grouping + erasure interactions live in merge-grouping.spec.ts. Here we only confirm
  // the toolset exists and the marks remain one-colour / outline-only.)
  await expect(page.getByTestId('tool-pan')).toBeVisible();
  await expect(page.getByTestId('tool-group')).toBeVisible();
  await expect(page.locator('svg path[stroke="#0ea5e9"]')).toHaveCount(2);
});
