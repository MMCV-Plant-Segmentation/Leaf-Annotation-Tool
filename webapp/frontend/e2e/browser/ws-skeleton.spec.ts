/**
 * Phase 0 acceptance for the annotation-ops WebSocket arc: a logged-in user opens
 * a WebSocket to /ws, sends {type:'ping'}, gets {type:'pong'}; an unauthenticated
 * connection is refused (never opens). No annotation-op routing yet — this is
 * the WS skeleton parity proof over the new Granian-ASGI serving path.
 */
import { test, expect } from '@playwright/test';

test('WS ping -> pong for a logged-in user', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-username')).toBeVisible();

  const reply = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const wsUrl = new URL('/ws', location.origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl.toString());
    const t = setTimeout(() => { try { ws.close(); } catch { /* noop */ } reject(new Error('ws timeout')); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onmessage = (ev) => { clearTimeout(t); resolve(String(ev.data)); try { ws.close(); } catch { /* noop */ } };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  }));

  expect(JSON.parse(reply)).toEqual({ type: 'pong' });
});

test('unauthenticated WS connect is rejected (never opens)', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  // /login is a static SPA route — reachable without auth.
  await page.goto('/login');

  const outcome = await page.evaluate(() => new Promise<{ opened: boolean; closed: boolean }>((resolve) => {
    const wsUrl = new URL('/ws', location.origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl.toString());
    let opened = false;
    const t = setTimeout(() => resolve({ opened, closed: false }), 6000);
    ws.onopen  = () => { opened = true; };
    ws.onclose = () => { clearTimeout(t); resolve({ opened, closed: true }); };
    ws.onerror = () => { /* swallow — onclose still fires */ };
  }));

  expect(outcome.opened).toBe(false);
  expect(outcome.closed).toBe(true);
  await ctx.close();
});
