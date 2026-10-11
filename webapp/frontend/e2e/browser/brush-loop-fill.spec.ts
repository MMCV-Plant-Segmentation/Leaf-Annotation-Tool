/**
 * Live brush LOOP FILL (Christian 2026-10-11): a brush stroke that comes back onto itself must
 * fill the enclosed area LIVE, before the pen lifts — as the pre-t158 preview did, and as the
 * stored (hole-dropped) outline does. The t158 round-stroke preview left the hole open.
 *
 * Setup mirrors canvas-layout-stable.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAsFreshUser } from './freshUser';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

type Tile = { x: number; y: number; w: number; h: number };

async function setupCanvas(page: Page): Promise<{ pid: string; canvasUrl: string; username: string; token: string; tiles: Tile[] }> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', `Loop ${Date.now()}`);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const pid = page.url().split('/projects/')[1].split('?')[0];

  const username = `loop-${Date.now()}`;
  const user = await (await page.request.post('/api/users', { data: { username } })).json() as
    { id: number; invite: { token: string } };
  await page.request.post(`/api/projects/${pid}/annotators`, { data: { user_id: user.id } });

  await page.goto(`/projects/${pid}/images`);
  await page.fill('[data-testid="import-path"]', FIXTURE_NESTED);
  await page.click('button:text("Import")');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await page.goto(`/projects/${pid}/tiling`);
  await page.getByRole('button', { name: /save.*default/i }).click();
  await expect(page.getByRole('button', { name: /save.*default/i })).toBeEnabled({ timeout: 5000 });

  await page.goto(`/projects/${pid}`);
  await page.getByRole('button', { name: /create batch/i }).click();
  await expect(page.getByText(/batch 1/i)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /open canvas/i }).first().click();
  await expect(page).toHaveURL(/\/batches\/[a-f0-9-]{36}/, { timeout: 5000 });
  const canvasUrl = page.url();
  const batchId = canvasUrl.split('/batches/')[1].split('?')[0];
  const batch = await (await page.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json() as { images: { tiles: Tile[] }[] };
  return { pid, canvasUrl, username, token: user.invite.token, tiles: batch.images[0].tiles };
}

const ringArea = (r: number[][]) => Math.abs(r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

test('a brush stroke that closes on itself fills the enclosed area live, and stores it solid', async ({ page, browser }) => {
  const { canvasUrl, username, token, tiles } = await setupCanvas(page);
  const p = await loginAsFreshUser(browser, username, token);
  p.on('dialog', (d) => void d.dismiss());
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await p.getByTestId('tool-brush').click();
  const svg = p.locator('svg').first();
  await expect(svg).toBeVisible({ timeout: 10000 });
  const box = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const t = tiles.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const icx = t.x + t.w / 2, icy = t.y + t.h / 2, R = Math.min(t.w, t.h) / 3;  // image px
  const scr = (ix: number, iy: number): [number, number] =>
    [box.x + (box.width - vbW * scale) / 2 + ix * scale, box.y + (box.height - vbH * scale) / 2 + iy * scale];

  const loopPaths = () => p.getByTestId('brush-draft-loop').evaluateAll(
    (els) => els.filter((e) => (e.getAttribute('d') ?? '').length > 0).length);
  // Draw a circle, 1.2 turns, and check the preview BEFORE lifting the pen.
  const N = 90;
  await p.mouse.move(...scr(icx + R, icy));
  await p.mouse.down();
  for (let i = 1; i <= N; i++) {
    const a = (i / N) * 2 * Math.PI * 1.2;
    await p.mouse.move(...scr(icx + R * Math.cos(a), icy + R * Math.sin(a)));
    if (i === Math.round(N / 1.2) - 10) expect(await loopPaths()).toBe(0);  // not closed yet
  }
  await expect.poll(loopPaths, { timeout: 3000 }).toBeGreaterThan(0);
  // …and the loop is cut out of the edge/halo mask, so no inner edge line is drawn across the fill.
  expect(await p.locator('[data-testid="brush-draft"] mask path[fill="black"]').evaluateAll(
    (els) => els.filter((e) => (e.getAttribute('d') ?? '').length > 0).length)).toBeGreaterThan(0);
  await p.mouse.up();

  // Stored: one solid region (outer ring only, no hole) covering the disc.
  const batchId = canvasUrl.split('/batches/')[1].split('?')[0];
  await expect.poll(async () => (await (await p.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json()).images[0].annotations.length,
  { timeout: 8000 }).toBe(1);
  const ann = (await (await p.request.get(
    `/api/batches/${batchId}?annotator=${encodeURIComponent(username)}`)).json()).images[0].annotations[0];
  expect(ann.rings).toHaveLength(1);
  expect(ringArea(ann.rings[0])).toBeGreaterThan(0.9 * Math.PI * R * R);
});
