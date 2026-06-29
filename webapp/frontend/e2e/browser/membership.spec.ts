/**
 * Browser e2e tests for project-membership authorization (Fix 3).
 *   P1. A non-member user cannot open another user's project: the backend returns
 *       403 and the project view does not render (delete-project button absent).
 */
import { test, expect } from '@playwright/test';

/**
 * Create a fresh non-admin user via admin API, accept the invite to set a password,
 * and return a new browser context with that user logged in.
 */
async function createNonAdminContext(
  adminPage: import('@playwright/test').Page,
  browser: import('@playwright/test').Browser,
  pw = 'TestPass99!',
): Promise<import('@playwright/test').BrowserContext> {
  const username = `memtest-${Date.now()}`;
  const createResp = await adminPage.request.post('/api/users', { data: { username } });
  expect(createResp.ok()).toBeTruthy();
  const { invite } = (await createResp.json()) as { invite: { token: string } };

  // Accept invite from a throwaway anonymous context.
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(`/api/invite/${invite.token}`, {
    data: { password: pw, confirm: pw },
  });
  expect(acceptResp.ok()).toBeTruthy();
  await anonCtx.close();

  // Log in as the new user in a fresh context.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.fill('#login-username', username);
  await p.fill('#login-password', pw);
  await p.click('button[type=submit]');
  await expect(p.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });
  return ctx;
}

// ── P1: non-member cannot open another user's project ─────────────────────────

test('P1: non-member cannot view another users project — backend 403 + view not rendered', async ({ page, browser }) => {
  // Admin creates a project (admin is auto-added as a member by Fix 3).
  const projResp = await page.request.post('/api/projects', {
    data: { name: 'Admin-only project' },
  });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  // Verify admin can access it.
  const adminCheck = await page.request.get(`/api/projects/${id}`);
  expect(adminCheck.status()).toBe(200);

  // Create a second user (non-admin, non-member) in a fresh login context.
  const ctx = await createNonAdminContext(page, browser);
  const p2 = await ctx.newPage();

  // The non-member's API call should return 403.
  const apiResp = await p2.request.get(`/api/projects/${id}`);
  expect(apiResp.status()).toBe(403);

  // Navigating to the project hub should NOT render the project view.
  await p2.goto(`/projects/${id}`);
  // Wait for the SolidJS app to settle (resource fetch resolves to error).
  await p2.waitForTimeout(2000);
  // The delete-project button is part of the project hub view and must not appear.
  await expect(p2.getByTestId('delete-project')).not.toBeVisible({ timeout: 3000 });

  await ctx.close();
});
