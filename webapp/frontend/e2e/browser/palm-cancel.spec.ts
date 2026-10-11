/**
 * t161 — a CANCELLED touch must not stay "down" on the canvas.
 *
 * Christian (2026-10-10, iPad): resting a palm while drawing turned pen + palm into a two-finger
 * pan/zoom; and after lifting the palm, every later pen stroke STILL behaved as a pinch until a page
 * reload. iOS ends a rejected palm touch with `pointercancel`, never `pointerup` — and the canvas only
 * forgot a pointer on `pointerup`, so the palm stayed in its multi-touch set forever.
 *
 * Here: a real (CDP) touch lands on the canvas and is cancelled; then an ordinary stroke must draw.
 * Setup mirrors canvas-layout-stable.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAsFreshUser } from './freshUser';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

type Tile = { x: number; y: number; w: number; h: number };

async function setupCanvas(page: Page): Promise<{ canvasUrl: string; username: string; token: string; tiles: Tile[] }> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', `Palm ${Date.now()}`);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const pid = page.url().split('/projects/')[1].split('?')[0];

  const username = `palm-${Date.now()}`;
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
  return { canvasUrl, username, token: user.invite.token, tiles: batch.images[0].tiles };
}

test('a cancelled (palm) touch is forgotten — the next stroke draws, not pinches', async ({ page, browser }) => {
  const { canvasUrl, username, token, tiles } = await setupCanvas(page);
  const p = await loginAsFreshUser(browser, username, token);
  p.on('dialog', (d) => void d.dismiss());
  await p.goto(canvasUrl);
  await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
  await p.getByTestId('tool-brush').click();

  const svg = p.locator('svg').first();
  await expect(svg).toBeVisible({ timeout: 10000 });
  await expect(p.locator('svg path[stroke]')).toHaveCount(0);
  const box = await svg.boundingBox();
  const viewBox = await svg.getAttribute('viewBox');
  if (!box || !viewBox) throw new Error('canvas svg missing boundingBox/viewBox');
  const t = tiles[0];
  const [, , vbW, vbH] = viewBox.split(' ').map(Number);
  const scale = Math.min(box.width / vbW, box.height / vbH);
  const cx = box.x + (box.width - vbW * scale) / 2 + (t.x + t.w / 2) * scale;
  const cy = box.y + (box.height - vbH * scale) / 2 + (t.y + t.h / 2) * scale;

  // Record what the canvas actually receives, so the test can't pass on a touch that never landed.
  await svg.evaluate((el) => {
    const w = window as unknown as { __pe: string[] };
    w.__pe = [];
    for (const ty of ['pointerdown', 'pointercancel']) {
      el.addEventListener(ty, (e) => w.__pe.push(`${e.type}:${(e as PointerEvent).pointerType}`));
    }
  });

  // The "palm": a real touch that lands, then is cancelled by the platform (no pointerup).
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx + 40, y: cy + 40, id: 7 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(() => p.evaluate(() => (window as unknown as { __pe: string[] }).__pe))
    .toEqual(['pointerdown:touch', 'pointercancel:touch']);
  await expect(p.locator('svg path[stroke]')).toHaveCount(0);  // the cancelled touch committed nothing

  // The palm is gone: an ordinary stroke must now draw (it used to be read as the 2nd pinch finger).
  await p.mouse.move(cx - 15, cy - 15);
  await p.mouse.down();
  for (let i = 1; i <= 5; i++) await p.mouse.move(cx - 15 + i * 6, cy - 15 + i * 4);
  await p.mouse.up();
  await expect(p.locator('svg path[stroke]').first()).toBeVisible({ timeout: 5000 });
});
