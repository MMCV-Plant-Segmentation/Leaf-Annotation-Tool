/**
 * t161 — pen mode + the brush button's hidden popup.
 *
 * Christian (2026-10-10): by default the pen is just another pointer (mouse is the main target).
 * An OPT-IN pen mode: only the pen draws, the pen only draws; touch only pans/zooms; while the pen is
 * down ALL touch is ignored (pan-while-drawing is a later setting, t163). Pen mode and the /calibrate
 * page live in a popup opened by right-click / long-press on the Brush button — hidden (no marker),
 * but the button shows a badge while pen mode is on. A long-press must not trigger the browser's own
 * text-selection / callout, here or on the calibrate page.
 *
 * Pen input = CDP `Input.dispatchMouseEvent` with `pointerType: 'pen'`; touch = CDP touch events.
 * Every helper records what the canvas actually received, so no test can pass on input that never
 * landed. Setup mirrors palm-cancel.spec.ts.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { loginAsFreshUser } from './freshUser';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

type Tile = { x: number; y: number; w: number; h: number };

async function setupCanvas(page: Page): Promise<{ canvasUrl: string; username: string; token: string; tiles: Tile[] }> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', `Pen ${Date.now()}`);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  const pid = page.url().split('/projects/')[1].split('?')[0];

  const username = `pen-${Date.now()}`;
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

type Ctx = { p: Page; cdp: CDPSession; cx: number; cy: number };

/** Logged-in annotator on the canvas, Brush selected, CDP touch enabled, centre of tile 0 in client px. */
async function openCanvas(page: Page, browser: Parameters<typeof loginAsFreshUser>[0]): Promise<Ctx> {
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
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // Record the pointer types the canvas receives (anti-vacuous: the input must actually land).
  await svg.evaluate((el) => {
    const w = window as unknown as { __pd: string[] };
    w.__pd = [];
    el.addEventListener('pointerdown', (e) => w.__pd.push((e as PointerEvent).pointerType));
  });
  return { p, cdp, cx, cy };
}

const received = (p: Page) => p.evaluate(() => (window as unknown as { __pd: string[] }).__pd);
const viewBox = (p: Page) => p.locator('svg').first().getAttribute('viewBox');
const strokes = (p: Page) => p.locator('svg path[stroke]');

async function penDown(c: Ctx, x: number, y: number) {
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
}
async function penMove(c: Ctx, x: number, y: number) {
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen' });
}
async function penUp(c: Ctx, x: number, y: number) {
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
}
async function penStroke(c: Ctx, x0: number, y0: number) {
  await penDown(c, x0, y0);
  for (let i = 1; i <= 6; i++) await penMove(c, x0 + i * 6, y0 + i * 4);
  await penUp(c, x0 + 36, y0 + 24);
}
async function touchDrag(c: Ctx, x0: number, y0: number, dx: number, dy: number, id = 3) {
  await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id }] });
  for (let i = 1; i <= 6; i++) {
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / 6, y: y0 + dy * i / 6, id }] });
  }
  await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function enablePenMode(p: Page) {
  await p.getByTestId('tool-brush').click({ button: 'right' });
  await expect(p.getByTestId('brush-menu')).toBeVisible();
  await p.getByTestId('pen-mode-toggle').click();
  await expect(p.getByTestId('pen-mode-badge')).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('brush-menu')).toHaveCount(0);
}

test.describe('brush popup', () => {
  test('right-click opens it (browser menu suppressed); it holds pen mode + calibrate; the toolbar link is gone', async ({ page, browser }) => {
    const { p } = await openCanvas(page, browser);
    await expect(p.getByTestId('brush-menu')).toHaveCount(0);
    await expect(p.getByTestId('calibrate-link')).toHaveCount(0);  // moved into the popup
    await expect(p.getByTestId('pen-mode-badge')).toHaveCount(0);  // off by default

    await p.getByTestId('tool-brush').evaluate((el) => {
      const w = window as unknown as { __ctx: boolean[] };
      w.__ctx = [];
      // Read defaultPrevented AFTER dispatch finishes: Solid delegates contextmenu to the document, so a
      // microtask here would run before the app's (bubbling) handler gets the event.
      el.addEventListener('contextmenu', (e) => setTimeout(() => w.__ctx.push(e.defaultPrevented), 0));
    });
    await p.getByTestId('tool-brush').click({ button: 'right' });
    await expect(p.getByTestId('brush-menu')).toBeVisible();
    await expect.poll(() => p.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx)).toEqual([true]);
    await expect(p.getByTestId('pen-mode-toggle')).toBeVisible();
    await expect(p.getByTestId('brush-menu-calibrate')).toHaveAttribute('href', '/calibrate');

    await p.keyboard.press('Escape');
    await expect(p.getByTestId('brush-menu')).toHaveCount(0);
    // An outside click closes it too.
    await p.getByTestId('tool-brush').click({ button: 'right' });
    await expect(p.getByTestId('brush-menu')).toBeVisible();
    await p.getByTestId('tool-pan').click();
    await expect(p.getByTestId('brush-menu')).toHaveCount(0);
  });

  test('a plain click just selects Brush — no popup', async ({ page, browser }) => {
    const { p } = await openCanvas(page, browser);
    await p.getByTestId('tool-pan').click();
    await p.getByTestId('tool-brush').click();
    await expect(p.getByTestId('tool-brush')).toHaveAttribute('aria-pressed', 'true');
    await expect(p.getByTestId('brush-menu')).toHaveCount(0);
  });

  test('a long-press (touch) opens it; the button cannot be text-selected', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    const btn = c.p.getByTestId('tool-brush');
    const style = await btn.evaluate((el) => {
      const s = getComputedStyle(el);
      return { u: s.userSelect, wu: s.getPropertyValue('-webkit-user-select') };
    });
    expect(style.u).toBe('none');
    expect(style.wu).toBe('none');

    const b = (await btn.boundingBox())!;
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 9 }] });
    await c.p.waitForTimeout(900);
    await expect(c.p.getByTestId('brush-menu')).toBeVisible();  // opens while still held
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(c.p.getByTestId('brush-menu')).toBeVisible();  // and survives the release

    // A short tap is NOT a long-press.
    await c.p.keyboard.press('Escape');
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 10 }] });
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await c.p.waitForTimeout(900);
    await expect(c.p.getByTestId('brush-menu')).toHaveCount(0);
  });

  test('pen mode shows a badge on Brush and persists across reload (per device)', async ({ page, browser }) => {
    const { p } = await openCanvas(page, browser);
    await enablePenMode(p);
    await p.reload();
    await expect(p.getByTestId('canvas-toolbar')).toBeVisible({ timeout: 5000 });
    await expect(p.getByTestId('pen-mode-badge')).toBeVisible();
    await p.getByTestId('tool-brush').click({ button: 'right' });
    await p.getByTestId('pen-mode-toggle').click();
    await expect(p.getByTestId('pen-mode-badge')).toHaveCount(0);
  });
});

test.describe('pen mode on the canvas', () => {
  test('OFF (default): a finger draws, as before', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    await touchDrag(c, c.cx - 15, c.cy - 15, 40, 30);
    expect(await received(c.p)).toEqual(['touch']);
    await expect(strokes(c.p).first()).toBeVisible({ timeout: 5000 });
  });

  test('ON: a finger pans and never draws; the pen draws', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    await enablePenMode(c.p);
    const vb0 = await viewBox(c.p);
    await touchDrag(c, c.cx - 15, c.cy - 15, 60, 40);
    expect(await received(c.p)).toEqual(['touch']);
    await expect.poll(() => viewBox(c.p)).not.toBe(vb0);  // it panned
    await c.p.waitForTimeout(300);
    await expect(strokes(c.p)).toHaveCount(0);           // and drew nothing

    await penStroke(c, c.cx - 15, c.cy - 15);
    expect(await received(c.p)).toEqual(['touch', 'pen']);
    await expect(strokes(c.p).first()).toBeVisible({ timeout: 5000 });
  });

  test('ON: a finger never draws with the eraser either', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    await enablePenMode(c.p);
    await penStroke(c, c.cx - 15, c.cy - 15);
    await expect(strokes(c.p)).toHaveCount(1, { timeout: 5000 });
    await c.p.getByTestId('tool-eraser').click();
    await touchDrag(c, c.cx - 15, c.cy - 15, 36, 24);
    await c.p.waitForTimeout(500);
    await expect(strokes(c.p)).toHaveCount(1);  // the finger did not erase it
  });

  test('ON: a palm landing mid-stroke is ignored — one stroke, no pan/zoom', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    await enablePenMode(c.p);
    const vb0 = await viewBox(c.p);
    const x0 = c.cx - 15, y0 = c.cy - 15;
    await penDown(c, x0, y0);
    for (let i = 1; i <= 3; i++) await penMove(c, x0 + i * 6, y0 + i * 4);
    // Palm lands and drags (would be a one-finger pan, or a pinch with the pen as 2nd pointer).
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.cx + 60, y: c.cy + 60, id: 5 }] });
    for (let i = 1; i <= 4; i++) {
      await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.cx + 60 + i * 15, y: c.cy + 60 + i * 10, id: 5 }] });
      await penMove(c, x0 + (3 + i) * 6, y0 + (3 + i) * 4);
    }
    await penUp(c, x0 + 42, y0 + 28);
    await c.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await received(c.p)).toEqual(['pen', 'touch']);
    await expect(strokes(c.p)).toHaveCount(1, { timeout: 5000 });
    expect(await viewBox(c.p)).toBe(vb0);
  });

  test('ON: the mouse still draws (pen mode only changes touch)', async ({ page, browser }) => {
    const c = await openCanvas(page, browser);
    await enablePenMode(c.p);
    await c.p.mouse.move(c.cx - 15, c.cy - 15);
    await c.p.mouse.down();
    for (let i = 1; i <= 5; i++) await c.p.mouse.move(c.cx - 15 + i * 6, c.cy - 15 + i * 4);
    await c.p.mouse.up();
    await expect(strokes(c.p).first()).toBeVisible({ timeout: 5000 });
  });
});

test('calibrate page: drawing cannot select page text (the report stays selectable)', async ({ page }) => {
  await page.goto('/calibrate');
  const screen = page.getByTestId('calibrate-screen');
  await expect(screen).toBeVisible();
  const s = await screen.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { u: cs.userSelect, wu: cs.getPropertyValue('-webkit-user-select') };
  });
  expect(s.u).toBe('none');
  expect(s.wu).toBe('none');
  // Draw a stroke so the report appears; it must remain selectable for copy.
  const box = (await page.getByTestId('calibrate-pad').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
  await page.mouse.up();
  const report = page.getByTestId('calibrate-report');
  await expect(report).toBeVisible();
  expect(await report.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none');
});
