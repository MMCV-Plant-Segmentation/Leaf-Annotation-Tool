import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Accept `invite` as `username`, then log in through the real login form in a fresh context.
 *
 * Waits for the login screen's post-login HARD redirect to `/` to land, not just for the auth
 * badge: the badge renders as soon as the user is loaded, a beat BEFORE `location.href = '/'`
 * fires, so a caller's next `goto` could race that redirect ("navigation interrupted by another
 * navigation to /") — a flake that surfaced under the containerized gate's timing.
 */
export async function loginAsFreshUser(browser: Browser, username: string, invite: string): Promise<Page> {
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
  await p.waitForURL((url) => url.pathname === '/', { timeout: 8000 });
  await expect(p.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  return p;
}
