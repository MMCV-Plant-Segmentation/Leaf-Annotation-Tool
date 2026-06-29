import { test, expect } from '@playwright/test';

// ── Unauthenticated context (no session cookie) ────────────────────────────

test('unauthenticated GET / redirects to /login', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  // SolidJS router handles redirect client-side; AppRoot fetches /api/me → null → nav('/login')
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test('/login renders sign-in form', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await ctx.close();
});

test('wrong password shows error', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.getByText('Invalid username or password')).toBeVisible();
  await ctx.close();
});

// ── Authenticated tests (use saved session from globalSetup) ───────────────

test('home screen visible when authenticated', async ({ page }) => {
  await page.goto('/');
  // The auth bar shows the username; target the username span specifically (a bare
  // text=admin also matches the "Admin" admin-nav button → strict-mode ambiguity).
  await expect(page.getByTestId('auth-username')).toBeVisible();
});

test('logout redirects to /login', async ({ page }) => {
  await page.goto('/');
  // Wait for the Solid app to finish mounting + resolving auth before interacting,
  // otherwise the click can race the auth bar's render (flaky redirect).
  await expect(page.getByTestId('auth-username')).toBeVisible();
  await page.click('button:text("Log out")');
  await expect(page).toHaveURL(/\/login/);
});

// ── Admin panel ────────────────────────────────────────────────────────────

test('admin can navigate to /admin', async ({ page }) => {
  await page.goto('/admin');
  // Target the tab button specifically (avoids matching the "Users" section heading too)
  await expect(page.getByRole('tab', { name: 'Users' })).toBeVisible();
});

// ── Fix 1: admin UI gate — non-admin bounced from /admin ──────────────────

test('non-admin navigating to /admin is redirected to home', async ({ page, browser }) => {
  // Create a non-admin user via the admin API.
  // NOTE: avoid 'admin' in the username — it would contaminate the roster autocomplete
  // in other tests that search for the exact user 'admin' (substring match).
  const username = `gatetest-${Date.now()}`;
  const createResp = await page.request.post('/api/users', { data: { username } });
  expect(createResp.ok()).toBeTruthy();
  const { invite } = (await createResp.json()) as { invite: { token: string } };

  // Accept the invite to set a password.
  const pw = 'TestPass99!';
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(`/api/invite/${invite.token}`, {
    data: { password: pw, confirm: pw },
  });
  expect(acceptResp.ok()).toBeTruthy();
  await anonCtx.close();

  // Log in as non-admin.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p2 = await ctx.newPage();
  await p2.goto('/login');
  await p2.fill('#login-username', username);
  await p2.fill('#login-password', pw);
  await p2.click('button[type=submit]');
  await expect(p2.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });

  // Navigate directly to /admin — should be bounced to home.
  await p2.goto('/admin');
  await expect(p2).not.toHaveURL(/\/admin/, { timeout: 5000 });
  // Should be at / (home).
  await expect(p2).toHaveURL(/\/$/, { timeout: 5000 });
  await ctx.close();
});

test('admin can create a user and see invite token', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByTestId('auth-username')).toBeVisible(); // app-ready before interacting
  const username = `testuser-${Date.now()}`;
  await page.fill('input[placeholder="New username"]', username);
  await page.click('button:text("Add")');
  await expect(page.getByText(username, { exact: true })).toBeVisible();
  // Scope invite assertion to this user's row to avoid matching other users' invites.
  // DOM: span.userName → div.userRowHeader → div.userRow (which also holds div.inviteRow)
  const userRow = page.locator(`span:text-is("${username}")`).locator('xpath=../..');
  await expect(userRow.locator('text=/Invite/')).toBeVisible();
});

test('admin can open settings tab', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByTestId('auth-username')).toBeVisible(); // app-ready before interacting
  await page.click('button[role=tab]:text("Settings")');
  await expect(page.locator('#setting-backup-dir')).toBeVisible();
});
