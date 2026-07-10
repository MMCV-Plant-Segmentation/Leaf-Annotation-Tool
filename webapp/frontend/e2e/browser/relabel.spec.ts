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
import { test, expect, type Page, type Browser, type Locator } from '@playwright/test';

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
  Promise<{ p: Page; okColor: string; dangerColor: string; tiles: { x: number; y: number; w: number; h: number }[] }> {
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
  const batchId = canvasUrl.split('/batches/')[1].split('?')[0];

  const proj = await (await page.request.get(`/api/projects/${pid}`)).json() as
    { classes: { name: string; color: string }[] };
  const okColor = proj.classes.find((c) => c.name === 'ok')!.color.toLowerCase();
  const dangerColor = proj.classes.find((c) => c.name === 'danger')!.color.toLowerCase();

  // The batch samples RANDOM tile positions (create_batch shuffles + samples), so only some
  // tiles exist — a paint must land inside one or the server 422s "must intersect at least
  // one tile". Fetch the real server-assigned tiles for image 0 so the paint can anchor to a
  // guaranteed tile centre instead of guessing at the SVG centre (the BUGS #31 flake).
  const batch = await (await page.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json() as
    { images: { tiles: { x: number; y: number; w: number; h: number }[] }[] };
  const tiles = batch.images[0].tiles;

  const p = await loginAsFreshUser(browser, username, user.invite.token);
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  return { p, okColor, dangerColor, tiles };
}

/** Centre of the first real, server-assigned tile (image-space) — a paint anchored here is
 * guaranteed to intersect a tile, unlike a guessed fraction of the image. */
function tileCentre(tiles: { x: number; y: number; w: number; h: number }[]): [number, number] {
  const t = tiles[0];
  return [t.x + t.w / 2, t.y + t.h / 2];
}

/** Map an image-space point to screen coords given the <svg> box + its `viewBox`. The SVG uses
 * `preserveAspectRatio="xMidYMid meet"`, so the image is letterboxed within the box — this is
 * NOT a plain box.width/imgWidth scale. Robust across the fixture's 3 differently-sized images. */
function imgToScreen(box: { x: number; y: number; width: number; height: number }, viewBox: string, imgX: number, imgY: number): [number, number] {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const offsetX = box.x + (box.width - vbW * scale) / 2;
  const offsetY = box.y + (box.height - vbH * scale) / 2;
  return [offsetX + imgX * scale, offsetY + imgY * scale];
}

// The class picker is a custom Kobalte Select (colour-coded rows — a native <select>
// can't reliably colour its own <option> chrome), not a native <select>. Its CURRENT
// value shows as text in the trigger button; PICKING opens it (click) then clicks the
// matching option (role="option", from Kobalte's Listbox — full keyboard/ARIA support).
const classPickerValue = (toolbar: Locator) => toolbar.getByTestId('class-picker');

async function pickClass(p: Page, toolbar: Locator, name: string) {
  await toolbar.getByTestId('class-picker').click();
  await p.getByRole('option', { name }).click();
}

test('select a painted lesion, relabel via the paint drop-down, recolor, restore on deselect', async ({ page, browser }) => {
  const { p, okColor, dangerColor, tiles } = await setupRelabelCanvas(page, browser);
  const toolbar = p.getByTestId('canvas-toolbar');
  const classSelect = classPickerValue(toolbar);

  // Paint a stroke labelled 'ok' (the drop-down defaults to the first compound).
  await expect(classSelect).toContainText('ok', { timeout: 5000 });
  await p.getByTestId('tool-brush').click();
  // Wide brush so the later select-click at the drag's start point is comfortably inside the
  // mask — the default (~10% of a tile's diagonal) left almost no hit-test margin.
  const brushInput = p.getByTestId('brush-size-input');
  await brushInput.fill('50');
  await brushInput.press('Tab');
  p.on('dialog', (d) => void d.dismiss());
  const canvasSvg = p.locator('svg').first();
  await expect(canvasSvg).toBeVisible({ timeout: 10000 });
  const box = await canvasSvg.boundingBox();
  const viewBox = await canvasSvg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');
  // Anchor at a REAL server-assigned tile centre (mapped image→screen) so the paint always
  // intersects a tile — see setupRelabelCanvas (BUGS #31: the SVG-centre guess flaked on the
  // RNG seeds where no sampled tile covered the centre).
  const [cx, cy] = imgToScreen(box, viewBox, ...tileCentre(tiles));
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
  await expect(classSelect).toContainText('ok');

  // Pick 'danger' in the SAME drop-down → relabels + recolors the selected lesion.
  await pickClass(p, toolbar, 'danger');
  await expect(lesion).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Persists across a reload.
  await p.reload();
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await expect(p.locator('svg path[stroke]').first()).toHaveAttribute('stroke', new RegExp(dangerColor, 'i'));

  // Deselect (Escape) → drop-down restores to the last MANUALLY-chosen paint label
  // ('ok'), not left showing the relabel pick.
  await p.keyboard.press('Escape');
  await expect(classSelect).toContainText('ok');
});
