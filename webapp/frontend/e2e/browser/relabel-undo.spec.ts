/**
 * Compound labels Phase 2c — wiring `relabel` into undo/redo.
 *
 * Covers: paint a lesion → relabel it (paint drop-down, same as Phase 2b) → Ctrl+Z reverts
 * the label + colour (and the still-selected drop-down syncs back) → Ctrl+Shift+Z
 * re-applies it → the relabel entry interleaves correctly with a LATER paint's `draw`
 * history entry on the same stack (undoing the paint first, THEN reaching the relabel
 * below it, in order) → the relabel-undo persists across a reload.
 *
 * Setup mirrors relabel.spec.ts (Phase 2b): admin creates the project/roster/batch via
 * the UI/API, then a fresh REAL (non-admin) annotator does the canvas interaction (BUGS
 * #15: admin's canvas is a read-only viewer with no class picker).
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
 * roster member, then hands off to that annotator's own logged-in page for the canvas
 * interaction. Returns the annotator's page, the compounds' colours, and the actual
 * server-side tile rects for image 0 — used to pick paint anchors that are GUARANTEED to
 * land in a real tile (see tileCenters below) rather than guessing at fractions of the
 * image that might fall in a partial/excluded edge tile. */
async function setupCanvas(page: Page, browser: Browser):
  Promise<{ p: Page; okColor: string; dangerColor: string; tiles: { x: number; y: number; w: number; h: number }[] }> {
  const pid = await createProject(page, `RelabelUndo ${Date.now()}`);
  await page.request.patch(`/api/projects/${pid}`, { data: { classes: ['ok', 'danger'] } });

  const username = `relabel-undo-${Date.now()}`;
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

  const proj = await (await page.request.get(`/api/projects/${pid}`)).json() as
    { classes: { name: string; color: string }[] };
  const okColor = proj.classes.find((c) => c.name === 'ok')!.color.toLowerCase();
  const dangerColor = proj.classes.find((c) => c.name === 'danger')!.color.toLowerCase();

  const batch = await (await page.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json() as
    { images: { tiles: { x: number; y: number; w: number; h: number }[] }[] };
  const tiles = batch.images[0].tiles;

  const p = await loginAsFreshUser(browser, username, user.invite.token);
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  return { p, okColor, dangerColor, tiles };
}

/** Picks two tile CENTRES (image-space) as far apart as possible from the real,
 * server-assigned tile list — guaranteed to each intersect a real tile (unlike a guessed
 * fraction of the image, which can land in a partial/excluded edge tile). Falls back to
 * two corners of the same tile if there's only one. */
function tileAnchors(tiles: { x: number; y: number; w: number; h: number }[]): [[number, number], [number, number]] {
  const centre = (t: { x: number; y: number; w: number; h: number }): [number, number] => [t.x + t.w / 2, t.y + t.h / 2];
  if (tiles.length < 2) {
    const t = tiles[0];
    return [[t.x + t.w * 0.3, t.y + t.h * 0.3], [t.x + t.w * 0.7, t.y + t.h * 0.7]];
  }
  let best: [number, number, number] = [0, 1, -1]; // i, j, distSq
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const [ax, ay] = centre(tiles[i]), [bx, by] = centre(tiles[j]);
      const d = (ax - bx) ** 2 + (ay - by) ** 2;
      if (d > best[2]) best = [i, j, d];
    }
  }
  return [centre(tiles[best[0]]), centre(tiles[best[1]])];
}

/** A short brush drag starting at (cx - 15, cy - 15), producing one painted lesion.
 * Returns the drag's START point — guaranteed to lie ON the stroke's own path (unlike
 * some arbitrary point near it), so it's the one safe coordinate to click for selecting
 * this lesion afterwards (see relabel.spec.ts, which uses the same convention). */
async function paintStroke(p: Page, cx: number, cy: number): Promise<[number, number]> {
  const start: [number, number] = [cx - 15, cy - 15];
  await p.mouse.move(...start);
  await p.mouse.down();
  for (let i = 1; i <= 5; i++) await p.mouse.move(cx - 15 + i * 6, cy - 15 + i * 4);
  await p.mouse.up();
  return start;
}

/** Maps an image-space point to screen coordinates given the <svg>'s bounding box and its
 * `viewBox` (SVG uses `preserveAspectRatio="xMidYMid meet"` — the image may be letterboxed
 * within the box, so this isn't a plain linear box.width/imgWidth scale). Robust across the
 * fixture's 3 differently-sized nested images (200×180 / 220×160 / 240×200). */
function imgToScreen(box: { x: number; y: number; width: number; height: number }, viewBox: string, imgX: number, imgY: number): [number, number] {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const offsetX = box.x + (box.width - vbW * scale) / 2;
  const offsetY = box.y + (box.height - vbH * scale) / 2;
  return [offsetX + imgX * scale, offsetY + imgY * scale];
}

test('relabel undo/redo via Ctrl+Z/Ctrl+Shift+Z, interleaved with a paint undo, persists', async ({ page, browser }) => {
  const { p, okColor, dangerColor, tiles } = await setupCanvas(page, browser);
  const toolbar = p.getByTestId('canvas-toolbar');
  const classSelect = toolbar.locator('select');
  p.on('dialog', (d) => void d.dismiss());

  await expect(classSelect).toHaveValue('ok', { timeout: 5000 });
  await p.getByTestId('tool-brush').click();
  // A generously wide brush so a selection click anywhere near the drag path is
  // comfortably inside the mask — the default (~10% of a tile's diagonal) left almost
  // no margin for hit-test rounding, which made the later select-click intermittently
  // miss (~1-in-10 local repeat runs) even at the drag's own start point.
  const brushInput = p.getByTestId('brush-size-input');
  await brushInput.fill('50');
  await brushInput.press('Tab');
  const canvasSvg = p.locator('svg').first();
  await expect(canvasSvg).toBeVisible({ timeout: 10000 });
  const box = await canvasSvg.boundingBox();
  const viewBox = await canvasSvg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');
  // Two anchors at the centres of the two FARTHEST-APART real, server-assigned tiles —
  // guaranteed to each intersect a tile (painting outside one 422s, "annotation must
  // intersect at least one tile") and far enough apart that the two lesions never fuse
  // into one mask. A guessed fraction of the image risked landing in a partial/excluded
  // edge tile (intermittent 422 on the 2nd paint, seen ~25% of local repeat runs).
  const [anchorA, anchorB] = tileAnchors(tiles);
  const [ax, ay] = imgToScreen(box, viewBox, ...anchorA);
  const [bx, by] = imgToScreen(box, viewBox, ...anchorB);

  // Paint lesion A, labelled 'ok' (the drop-down's default).
  const [startAx, startAy] = await paintStroke(p, ax, ay);
  const lesionA = p.locator('svg path[stroke]').first();
  await expect(lesionA).toBeVisible({ timeout: 5000 });
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(okColor, 'i'));

  // Select it and relabel to 'danger' via the paint drop-down (Phase 2b). Click the
  // drag's own START point — guaranteed to be ON the stroke's path (the centre of the
  // drag's bounding box is NOT necessarily on the path itself for a short diagonal
  // stroke, which made this click intermittently miss the lesion).
  await p.getByTestId('tool-select').click();
  await p.mouse.click(startAx, startAy);
  await expect(classSelect).toHaveValue('ok');
  await classSelect.selectOption('danger');
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Ctrl+Z reverts the relabel: colour AND the (still-selected) drop-down go back to 'ok'.
  await p.keyboard.press('Control+z');
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(okColor, 'i'));
  await expect(classSelect).toHaveValue('ok');

  // Ctrl+Shift+Z re-applies it.
  await p.keyboard.press('Control+Shift+z');
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));
  await expect(classSelect).toHaveValue('danger');

  // Deselect (restores the drop-down to the remembered paint label 'ok'), then paint a
  // SECOND lesion — pushing a `draw` history entry ON TOP of the relabel entry.
  await p.keyboard.press('Escape');
  await expect(classSelect).toHaveValue('ok');
  await p.getByTestId('tool-brush').click();
  await paintStroke(p, bx, by);
  await expect(p.locator('svg path[stroke]')).toHaveCount(2, { timeout: 5000 });

  // Undo #1 pops the paint (draw) — NOT the relabel underneath it. Stack ordering.
  await p.keyboard.press('Control+z');
  await expect(p.locator('svg path[stroke]')).toHaveCount(1, { timeout: 5000 });
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Undo #2 now reaches the relabel entry below it.
  await p.keyboard.press('Control+z');
  await expect(lesionA).toHaveAttribute('stroke', new RegExp(okColor, 'i'));

  // The relabel-undo persisted server-side (label-only PATCH), not just a local revert.
  await p.reload();
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(p.locator('svg path[stroke]')).toHaveCount(1, { timeout: 5000 });
  await expect(p.locator('svg path[stroke]').first()).toHaveAttribute('stroke', new RegExp(okColor, 'i'));
});
