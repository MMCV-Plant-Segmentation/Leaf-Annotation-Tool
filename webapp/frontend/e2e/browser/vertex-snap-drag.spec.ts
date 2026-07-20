/**
 * t50 / t77 regression: same-polyline vertex SNAP (Christian, 2026-07-20 testing).
 *
 * Bug: snapping only fired BETWEEN polylines, never WITHIN one in-progress polyline. Root cause —
 * the per-click polyline edit re-minted every vertex id each click (the draw path only sent a ref for
 * a SNAPPED click, never for already-placed vertices), so a self-snap referenced an id that the same
 * edit had just thrown away. Fix: each create/edit ack's vertexIds are threaded back into the draft
 * refs, so placed vertices keep their ids (id-stable) and a self-snap lands on a stable vertex.
 *
 * (The cross-annotation move-propagation is covered deterministically by backend test_vertex_move;
 * the intermittent "can't see the path" is tracked separately — t82.)
 *
 * Uses the same real-server harness as polyline-perclick.spec.ts.
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
  return [box.x + (box.width - vbW * scale) / 2 + imgX * scale,
          box.y + (box.height - vbH * scale) / 2 + imgY * scale];
}
async function toScreen(p: Page, ix: number, iy: number): Promise<[number, number]> {
  const svg = p.locator('svg').first();
  const box = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing box/viewBox');
  return imgToScreen(box, viewBox, ix, iy);
}

async function setup(page: Page, browser: Browser) {
  const pid = await createProject(page, `Snap ${Date.now()}`);
  const username = `snap-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { data: { username } })).json() as
    { id: number; invite: { token: string } };
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
  const anon = await anonCtx.newPage();
  expect((await anon.request.post(`/api/invite/${user.invite.token}`, { data: { password: pw, confirm: pw } })).ok()).toBeTruthy();
  await anonCtx.close();
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.fill('#login-username', username); await p.fill('#login-password', pw);
  await p.click('button[type=submit]');
  await expect(p.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  return { p, batchId, username, canvasUrl, tiles };
}

test('a second vertex placed on the first of the SAME polyline snaps onto it (t77)', async ({ page, browser }) => {
  const { p, batchId, username, canvasUrl, tiles } = await setup(page, browser);
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const cx = Math.round(t.x + t.w / 2), cy = Math.round(t.y + t.h / 2);

  await p.goto(canvasUrl);
  await expect(p.locator('svg').first()).toBeVisible({ timeout: 10000 });
  await p.getByTestId('tool-polyline').click();
  await expect(p.getByTestId('tool-polyline')).toHaveAttribute('aria-pressed', 'true');

  // The per-click edit re-mints the annotation id, so always re-read the CURRENT single annotation.
  const readStroke = async () => {
    const live = await (await p.request.get(
      `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json();
    const ann = live.images[0].annotations[0];
    return ann ? ann.strokes[0] as { points: number[][]; vertexIds: string[] } : undefined;
  };
  // Click at a REALISTIC pace: each click's ack must settle (so the id-stable ref threading works)
  // before the next — a human placing vertices, not a rapid-fire burst.
  const clickAt = async (ix: number, iy: number, expectPts: number) => {
    await p.mouse.click(...await toScreen(p, ix, iy));
    await expect.poll(async () => (await readStroke())?.points.length, { timeout: 8000 }).toBe(expectPts);
  };
  await clickAt(cx - 15, cy, 1);
  await clickAt(cx + 20, cy + 5, 2);
  await clickAt(cx - 15, cy, 3);   // 3rd click BACK onto the 1st vertex → should snap onto it

  const stroke = (await readStroke())!;
  // The 3rd point should have SNAPPED onto the 1st → they reference the SAME vertex id.
  expect(stroke.vertexIds[2]).toBe(stroke.vertexIds[0]);
});
