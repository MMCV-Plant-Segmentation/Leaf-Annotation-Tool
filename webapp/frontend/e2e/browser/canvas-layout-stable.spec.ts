/**
 * The canvas must not move or resize when the FIRST stroke lands on an image.
 *
 * Christian (2026-10-10, iPad, every image): "weird jitter after the first brushstroke". Viewport
 * telemetry showed the stage's CSS height dropping 941 → 906 within ~1 s of each image's first
 * annotation: the colour legend below the canvas only rendered once a stroke existed, so its row
 * appeared and squeezed the stage (the `meet`-fitted image re-centred ~17 px up). The legend row
 * now always reserves its space.
 *
 * Setup mirrors relabel.spec.ts (admin builds project + roster + batch; a fresh real annotator
 * draws, since admin's canvas is a read-only viewer).
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAsFreshUser } from './freshUser';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

type Tile = { x: number; y: number; w: number; h: number };

async function setupCanvas(page: Page): Promise<{ pid: string; canvasUrl: string; username: string; token: string; tiles: Tile[] }> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', `Layout ${Date.now()}`);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const pid = page.url().split('/projects/')[1].split('?')[0];

  const username = `layout-${Date.now()}`;
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

test('the first stroke on an image does not resize or shift the canvas', async ({ page, browser }) => {
  const { canvasUrl, username, token, tiles } = await setupCanvas(page);
  const p = await loginAsFreshUser(browser, username, token);
  p.on('dialog', (d) => void d.dismiss());
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await p.getByTestId('tool-brush').click();

  const svg = p.locator('svg').first();
  await expect(svg).toBeVisible({ timeout: 10000 });
  await expect(p.locator('svg path[stroke]')).toHaveCount(0);
  const before = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!before || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');

  // Paint inside a real server-assigned tile (else the server rejects the stroke).
  const t = tiles[0];
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(before.width / vbW, before.height / vbH);
  const cx = before.x + (before.width - vbW * scale) / 2 + (t.x + t.w / 2) * scale;
  const cy = before.y + (before.height - vbH * scale) / 2 + (t.y + t.h / 2) * scale;
  await p.mouse.move(cx - 15, cy - 15);
  await p.mouse.down();
  for (let i = 1; i <= 5; i++) await p.mouse.move(cx - 15 + i * 6, cy - 15 + i * 4);
  await p.mouse.up();

  await expect(p.locator('svg path[stroke]').first()).toBeVisible({ timeout: 5000 });
  await expect(p.getByTestId('canvas-legend')).toBeVisible();
  const after = await svg.boundingBox();
  expect(after).toEqual(before);
});
