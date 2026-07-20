/**
 * Polyline per-click persistence — behavioural browser test (a11y #40 rebuild).
 *
 * Christian's decided model (2026-07-13): each click acts like a brush stroke on
 * finger-lift — persist + fuse immediately. The mask exists after the FIRST click and
 * grows one vertex per click (ONE stroke → ONE fused mask). Ctrl+Z peels ONE click at a
 * time (keep undoing to remove the line). ESC just switches to select and drops the
 * rubber-band; placed clicks stay persisted. Enter does nothing. Snapping near the first
 * vertex is NOT special — it's just another click.
 *
 * We stress the per-click FRAMEWORK, not pixel-perfect geometry. Clicks are clustered
 * tightly around ONE real, server-assigned tile's centre: a fraction-of-the-svg guess can
 * land off-tile, which 422s and RESETS the per-click session mid-line (canvasPolylinePersist
 * catches the rejection and drops the stroke id), so the next on-tile click mints a spurious
 * SECOND annotation — the non-determinism that made the first cut of this test flake. All
 * count reads use expect.poll (the persist round-trip is async; a bare read races it).
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

type Tile = { x: number; y: number; w: number; h: number };

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

/** Maps an image-space point to screen coords given the <svg>'s box + viewBox
 * (preserveAspectRatio letterboxes the image, so this isn't a plain box/img scale). */
function imgToScreen(box: { x: number; y: number; width: number; height: number }, viewBox: string, imgX: number, imgY: number): [number, number] {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const offsetX = box.x + (box.width - vbW * scale) / 2;
  const offsetY = box.y + (box.height - vbH * scale) / 2;
  return [offsetX + imgX * scale, offsetY + imgY * scale];
}

/** Full setup as admin then log in as a fresh real annotator so paint tools write.
 * Returns the annotator's page + the real server-assigned tiles for image 0. */
async function setupCanvasAsAnnotator(page: Page, browser: Browser): Promise<{ p: Page; tiles: Tile[] }> {
  const pid = await createProject(page, `Poly ${Date.now()}`);
  const username = `poly-${Date.now()}`;
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
  const batchId = canvasUrl.split('/batches/')[1].split('?')[0];

  const batch = await (await page.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json() as
    { images: { tiles: Tile[] }[] };
  const tiles = batch.images[0].tiles;

  const pw = 'TestPass99!';
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(`/api/invite/${user.invite.token}`, { data: { password: pw, confirm: pw } });
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
  return { p: p2, tiles };
}

/** Count of live annotation masks inside the canvas <svg>. AnnotationShape tags its fused
 * mask path with data-testid="annotation-mask" — count THAT, not `path[fill-rule=evenodd]`,
 * which also matches the SelectionHighlight + VertexHandles preview paths that appear when a
 * stroke is selected (they'd inflate the count once ESC switches to the select tool). */
async function maskCount(p: Page): Promise<number> {
  return await p.locator('svg').first().locator('[data-testid="annotation-mask"]').count();
}

/** Four clicks clustered tightly around ONE real tile's centre (image-space offsets → screen).
 * Tight + on the SAME tile so every click extends ONE stroke into ONE connected fused mask. */
async function clusterClicks(p: Page, tiles: Tile[]): Promise<Array<[number, number]>> {
  const svg = p.locator('svg').first();
  const box = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a)); // biggest tile = most room
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  const imgPts: Array<[number, number]> = [[cx - 3, cy - 3], [cx + 3, cy - 3], [cx + 3, cy + 3], [cx - 2, cy - 2]];
  return imgPts.map(([x, y]) => imgToScreen(box, viewBox, x, y));
}

test('polyline persists + fuses per click; Ctrl+Z peels one click; ESC leaves clicks @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  const { p, tiles } = await setupCanvasAsAnnotator(page, browser);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  p.on('dialog', (d) => void d.dismiss());

  await p.getByTestId('tool-polyline').click();
  await expect(p.getByTestId('tool-polyline')).toHaveAttribute('aria-pressed', 'true');
  const clicks = await clusterClicks(p, tiles);

  // 1st click: a mask APPEARS (persist+fuse per-click) — ONE mask.
  await p.mouse.click(...clicks[0]);
  await expect.poll(() => maskCount(p), { timeout: 10000 }).toBe(1);

  // clicks 2-4: still ONE mask — each extends the same stroke (edit_stroke), not a new
  // annotation. The 4th sits near the first vertex: NOT auto-close, just another step.
  for (const c of clicks.slice(1)) {
    await p.mouse.click(...c);
    await expect.poll(() => maskCount(p), { timeout: 5000 }).toBe(1);
  }

  // Undo is an async server round-trip and does NOT serialize rapid presses (see BACKLOG), and a
  // vertex-peel keeps the mask at count 1 (so we can't poll BETWEEN peels) — so we press ONE
  // Ctrl+Z at a time and let each settle before the next.
  const undoStep = async () => { await p.keyboard.press('Control+Z'); await p.waitForTimeout(800); };

  // Peel ONE vertex — the stroke still has vertices → still ONE mask.
  await undoStep();
  expect(await maskCount(p)).toBe(1);

  // t59 two-stage ESC: a rubber band is still up (vertices placed), so the FIRST ESC FINISHES
  // the polyline and STAYS on the polyline tool (the persisted mask stays); only a SECOND ESC —
  // rubber band now cleared by the finish — switches to select. (Supersedes the old single-stage
  // "ESC → select".)
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('tool-polyline')).toHaveAttribute('aria-pressed', 'true');
  expect(await maskCount(p)).toBe(1);
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  expect(await maskCount(p)).toBe(1);

  // Keep undoing — peel vertices 3 and 2, then undo the first `draw` → the annotation is
  // deleted → the whole line is gone (0 masks).
  await undoStep();
  await undoStep();
  await undoStep();
  await expect.poll(() => maskCount(p), { timeout: 5000 }).toBe(0);
});

test('polyline: Enter does NOT commit anything and does NOT clear placed vertices @full', async ({ page, browser }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  const { p, tiles } = await setupCanvasAsAnnotator(page, browser);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  p.on('dialog', (d) => void d.dismiss());
  await p.getByTestId('tool-polyline').click();
  const clicks = await clusterClicks(p, tiles);

  await p.mouse.click(...clicks[0]);
  await expect.poll(() => maskCount(p), { timeout: 10000 }).toBe(1);
  await p.mouse.click(...clicks[1]);
  await expect.poll(() => maskCount(p), { timeout: 5000 }).toBe(1);

  // Enter: no-op for polyline (nothing to commit, tool stays polyline, mask unchanged).
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('tool-polyline')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => maskCount(p), { timeout: 3000 }).toBe(1);
});
