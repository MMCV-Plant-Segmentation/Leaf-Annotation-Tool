/**
 * t50 vertex-snapping regressions (Christian, 2026-07-20 manual testing):
 *   #10 — dragging a SNAPPED (shared) vertex moves the handles but the annotation MASK (the
 *         transparent fill) doesn't re-render. Backend move is proven (test_vertex_move); this
 *         asserts on the RENDERED svg mask, since the API would hide a pure FE-render bug.
 *   #9  — snapping only fires BETWEEN polylines, not WITHIN one in-progress polyline (can't snap
 *         onto your own earlier vertex).
 *
 * Lives with the other browser e2es; uses the same real-server harness (ephemeral server + real
 * annotator login + image-space→screen mapping) as polyline-perclick.spec.ts.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

const FIXTURE_NESTED = process.env.HT_E2E_FIXTURE_DIR
  ? `${process.env.HT_E2E_FIXTURE_DIR}/images` : '/tmp/leaf-e2e-fixture/images';

type Tile = { id: string; x: number; y: number; w: number; h: number };

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', name);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  return page.url().split('/projects/')[1];
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

function imgToScreen(box: { x: number; y: number; width: number; height: number },
                     viewBox: string, imgX: number, imgY: number): [number, number] {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const offsetX = box.x + (box.width - vbW * scale) / 2;
  const offsetY = box.y + (box.height - vbH * scale) / 2;
  return [offsetX + imgX * scale, offsetY + imgY * scale];
}
async function toScreen(p: Page, ix: number, iy: number): Promise<[number, number]> {
  const svg = p.locator('svg').first();
  const box = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing box/viewBox');
  return imgToScreen(box, viewBox, ix, iy);
}
async function maskCount(p: Page): Promise<number> {
  return p.locator('svg').first().locator('[data-testid="annotation-mask"]').count();
}
/** True if ANY rendered mask's bounding box contains the given screen point (± pad). */
async function anyMaskCovers(p: Page, sx: number, sy: number, pad = 6): Promise<boolean> {
  const masks = p.locator('svg').first().locator('[data-testid="annotation-mask"]');
  const n = await masks.count();
  for (let i = 0; i < n; i++) {
    const b = await masks.nth(i).boundingBox();
    if (b && sx >= b.x - pad && sx <= b.x + b.width + pad && sy >= b.y - pad && sy <= b.y + b.height + pad) return true;
  }
  return false;
}

async function setup(page: Page, browser: Browser) {
  const pid = await createProject(page, `Snap ${Date.now()}`);
  const username = `snap-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { data: { username } })).json() as
    { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: user.id } });
  await importImages(page, pid);
  await confirmTiling(page, pid);
  const imageId = (await (await page.request.get(`/api/projects/${pid}`)).json()).images[0].id as string;
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
  const anon = await anonCtx.newPage();
  expect((await anon.request.post(`/api/invite/${user.invite.token}`, { data: { password: pw, confirm: pw } })).ok()).toBeTruthy();
  await anonCtx.close();
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.fill('#login-username', username); await p.fill('#login-password', pw);
  await p.click('button[type=submit]');
  await expect(p.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  return { p, pid, username, imageId, batchId, canvasUrl, tiles };
}

async function makeAnnotation(p: Page, pid: string, imageId: string, username: string, t: Tile,
    points: number[][], label: string, vertexRefs?: (string | null)[]) {
  const body: Record<string, unknown> = {
    imageId, annotator: username, kind: 'stroke', points, label, strokeWidth: 14, tool: 'polyline',
    viewport: { x: t.x, y: t.y, w: t.w, h: t.h },
  };
  if (vertexRefs) body.vertexRefs = vertexRefs;
  const r = await p.request.post(`/api/projects/${pid}/annotations`, { data: body });
  expect(r.status()).toBe(201);
  return r.json();
}
async function strokeOf(p: Page, batchId: string, username: string, annId: string) {
  const live = await (await p.request.get(`/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json();
  const a = live.images[0].annotations.find((x: { id: string }) => x.id === annId);
  return a.strokes[0] as { points: number[][]; vertexIds: string[] };
}

test('#10: dragging a shared (snapped) vertex re-renders BOTH masks (not just the handles)', async ({ page, browser }) => {
  const { p, pid, username, imageId, batchId, canvasUrl, tiles } = await setup(page, browser);
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const cx = Math.round(t.x + t.w / 2), cy = Math.round(t.y + t.h / 2);

  // A ('la') and B ('lb') share A's first vertex (via vertexRefs) — the persisted equivalent of a snap.
  const a = await makeAnnotation(p, pid, imageId, username, t, [[cx - 20, cy, 14], [cx + 10, cy - 15, 14]], 'la');
  const vShared = (await strokeOf(p, batchId, username, a.id)).vertexIds[0];
  const b = await makeAnnotation(p, pid, imageId, username, t, [[cx - 20, cy, 14], [cx - 20, cy + 35, 14]], 'lb', [vShared, null]);
  expect((await strokeOf(p, batchId, username, b.id)).vertexIds[0]).toBe(vShared);

  await p.goto(canvasUrl);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  await expect.poll(() => maskCount(p), { timeout: 10000 }).toBe(2);

  // Select tool, select B by clicking inside it, so its vertex handles render.
  await p.getByTestId('tool-select').click();
  await p.mouse.click(...await toScreen(p, cx - 20, cy + 33));

  // Drag the shared vertex handle from (cx-20,cy) to a far NEW spot — still inside the tile.
  const [hx, hy] = await toScreen(p, cx - 20, cy);
  const newIx = cx + 40, newIy = cy + 45;
  const [nx, ny] = await toScreen(p, newIx, newIy);
  await p.mouse.move(hx, hy); await p.mouse.down();
  await p.mouse.move((hx + nx) / 2, (hy + ny) / 2); await p.mouse.move(nx, ny);
  await p.mouse.up();

  // The RENDERED masks must follow to the new position (the #10 bug: handles move, fill doesn't).
  await expect.poll(() => anyMaskCovers(p, nx, ny), { timeout: 8000 }).toBe(true);
});

test('#9: a second vertex placed on the first of the SAME polyline snaps onto it', async ({ page, browser }) => {
  const { p, batchId, username, canvasUrl, tiles } = await setup(page, browser);
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const cx = Math.round(t.x + t.w / 2), cy = Math.round(t.y + t.h / 2);

  await p.goto(canvasUrl);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  await p.getByTestId('tool-polyline').click();
  await expect(p.getByTestId('tool-polyline')).toHaveAttribute('aria-pressed', 'true');
  await p.mouse.click(...await toScreen(p, cx - 15, cy));
  await expect.poll(() => maskCount(p), { timeout: 10000 }).toBe(1);
  // Second click a few px away — then a THIRD click back onto the FIRST vertex should snap.
  await p.mouse.click(...await toScreen(p, cx + 20, cy + 5));
  await p.mouse.click(...await toScreen(p, cx - 15, cy));

  // Poll until all 3 clicks have settled into one stroke (the per-click edit re-mints the
  // annotation id, so always re-read the current single annotation).
  const readStroke = async () => {
    const live = await (await p.request.get(
      `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json();
    const ann = live.images[0].annotations[0];
    return ann ? ann.strokes[0] as { points: number[][]; vertexIds: string[] } : undefined;
  };
  await expect.poll(async () => (await readStroke())?.points.length, { timeout: 10000 }).toBe(3);
  const stroke = (await readStroke())!;
  // The 3rd point should have SNAPPED onto the 1st → they reference the SAME vertex id.
  expect(stroke.vertexIds[2]).toBe(stroke.vertexIds[0]);
});

/** Largest rendered mask's bounding-box area (SVG props, no pixels) — a proxy for "the path is
 * visibly drawn". An empty/degenerate mask has ~0 area even though the element exists. */
async function maxMaskArea(p: Page): Promise<number> {
  const masks = p.locator('svg').first().locator('[data-testid="annotation-mask"]');
  const n = await masks.count();
  let best = 0;
  for (let i = 0; i < n; i++) {
    const b = await masks.nth(i).boundingBox();
    if (b) best = Math.max(best, b.width * b.height);
  }
  return best;
}

test('"can\'t see the path": the committed polyline mask stays visible while drawing + snapping', async ({ page, browser }) => {
  const { p, canvasUrl, tiles } = await setup(page, browser);
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const cx = Math.round(t.x + t.w / 2), cy = Math.round(t.y + t.h / 2);
  await p.goto(canvasUrl);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  await p.getByTestId('tool-polyline').click();

  // Zoom IN (Ctrl+scroll) over the tile — the realistic drawing zoom, untested until now.
  const [zx, zy] = await toScreen(p, cx, cy);
  await p.mouse.move(zx, zy);
  await p.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await p.mouse.wheel(0, -120);
  await p.keyboard.up('Control');
  await p.waitForTimeout(200);

  // Draw polyline A (an elbow). After each click the committed mask must have real area.
  await p.mouse.click(...await toScreen(p, cx - 25, cy));
  await expect.poll(() => maskCount(p), { timeout: 10000 }).toBe(1);
  await p.mouse.click(...await toScreen(p, cx, cy - 12));
  await p.mouse.click(...await toScreen(p, cx + 25, cy + 6));
  await expect.poll(() => maxMaskArea(p), { timeout: 8000 }).toBeGreaterThan(100);

  // Now draw polyline B whose FIRST click snaps onto A's first vertex (the snapping condition
  // Christian was in). The committed path must STILL be visible (this is the #"can't see the path").
  await p.mouse.click(...await toScreen(p, cx - 25, cy));   // snap onto A's first vertex
  await p.mouse.click(...await toScreen(p, cx - 25, cy + 30));
  await p.mouse.move(...await toScreen(p, cx - 10, cy + 45)); // show the rubber band
  await expect.poll(() => maxMaskArea(p), { timeout: 8000 }).toBeGreaterThan(100);
});
