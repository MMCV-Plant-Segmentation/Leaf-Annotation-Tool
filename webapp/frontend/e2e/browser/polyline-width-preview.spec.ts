/**
 * Polyline live drawing preview shows WIDTH — not a zero-width hairline.
 *
 * Regression cover for the fix that mirrors the brush/eraser hover-radius preview onto the
 * polyline click-brush. Before the fix, selecting polyline + placing one vertex + moving the
 * cursor only rendered a thin dashed rubber-band (stroke-width ~2) so the user could not
 * see the stroke thickness before committing. After the fix:
 *   - a `polyline-cursor-preview` circle at the cursor conveys `brushSize/2` radius (like
 *     the brush hover preview);
 *   - a `polyline-width-preview` width-buffered band spans the pending segment (last vertex
 *     to cursor) so the user sees the actual thickness of the next segment;
 *   - the existing `polyline-rubberband` dashed centerline stays as a direction guide.
 *
 * The test setup mirrors annotator-config.spec.ts's canvas-as-annotator flow (BUGS #15:
 * admin can only view; paint tools require a real annotator identity).
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

async function setupCanvasAsAnnotator(page: Page, browser: Browser): Promise<Page> {
  const pid = await createProject(page, `PolyPreview ${Date.now()}`);

  const username = `polypreview-${Date.now()}`;
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

  const pw = 'TestPass99!';
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(
    `/api/invite/${user.invite.token}`, { data: { password: pw, confirm: pw } });
  expect(acceptResp.ok()).toBeTruthy();
  await anonCtx.close();

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p2 = await ctx.newPage();
  await p2.goto('/login');
  await p2.fill('#login-username', username);
  await p2.fill('#login-password', pw);
  await p2.click('button[type=submit]');
  await expect(p2.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  await p2.goto(canvasUrl);
  await expect(p2.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  return p2;
}

test('polyline live preview shows brush width, not a hairline @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  // Heavy end-to-end setup (create project + user + batch + login as annotator + navigate to
  // canvas) plus SVG interaction easily overflows Playwright's 30 s default on a busy runner.
  test.setTimeout(90_000);
  const p = await setupCanvasAsAnnotator(page, browser);

  // The canvas SVG mounts only after the batch resource resolves — wait for it explicitly
  // rather than relying on the (many) icon SVGs in the toolbar/header.
  const canvasSvg = p.locator('[data-screen="canvas"] svg').first();
  await expect(canvasSvg).toBeVisible({ timeout: 15_000 });

  // Switch to the polyline click-brush. The brush-size signal is shared across brush/eraser/
  // polyline (see CanvasScreen: single `brushSize` signal), so no need to interact with the
  // size UI here — we just assert the preview reflects a NON-ZERO radius (i.e. not the
  // pre-fix hairline).
  await p.getByTestId('tool-polyline').click();

  // Place ONE vertex, then move the cursor — no second click, so the polyline stays open
  // and nothing commits. Dismiss any stray "must intersect a tile" alert just in case.
  p.on('dialog', (d) => void d.dismiss());
  const box = await canvasSvg.boundingBox();
  const cx = (box?.x ?? 200) + (box?.width ?? 200) / 2;
  const cy = (box?.y ?? 200) + (box?.height ?? 200) / 2;
  await p.mouse.move(cx - 40, cy - 40);
  await p.mouse.click(cx - 40, cy - 40);                  // drops vertex #1
  await p.mouse.move(cx + 50, cy + 50, { steps: 8 });     // hover → triggers previews

  // Existing dashed rubber-band centerline still renders (unchanged for direction cues).
  await expect(p.locator('[data-testid="polyline-rubberband"]')).toBeVisible();

  // NEW: width-buffered band from the last vertex to the cursor exists and is a real 2-D
  // shape (not a hairline). The band spans a ~90 image-unit diagonal, so its bounding box
  // has substantial area — decisively wider than the pre-fix ~2 px hairline this guards.
  const band = p.locator('[data-testid="polyline-width-preview"]');
  await expect(band).toBeVisible();
  const bandBox = await band.boundingBox();
  expect(bandBox, 'width preview must have a bounding box').not.toBeNull();
  expect((bandBox!.width) * (bandBox!.height)).toBeGreaterThan(500);

  // NEW: cursor-radius circle exists at the cursor and its radius is a positive brush/2
  // value — i.e. the polyline hover-preview conveys thickness like brush/eraser does.
  const cursor = p.locator('[data-testid="polyline-cursor-preview"]');
  await expect(cursor).toBeVisible();
  const r = Number(await cursor.getAttribute('r'));
  expect(r).toBeGreaterThan(0);
});
