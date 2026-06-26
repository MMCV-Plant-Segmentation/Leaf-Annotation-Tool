import { test, expect } from '@playwright/test';

// ── Unauthenticated context (no session cookie) ────────────────────────────

test('unauthenticated GET / redirects to /login', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  // SolidJS router handles redirect client-side; AppRoot fetches /api/me → null → nav('/login')
  await page.goto('http://localhost:5000/');
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test('/login renders sign-in form', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5000/login');
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await ctx.close();
});

test('wrong password shows error', async ({ browser }) => {
  const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5000/login');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.getByText('Invalid username or password')).toBeVisible();
  await ctx.close();
});

// ── Authenticated tests (use saved session from globalSetup) ───────────────

test('home screen visible when authenticated', async ({ page }) => {
  await page.goto('http://localhost:5000/');
  // The auth bar shows the username; route renders without redirect to /login
  await expect(page.locator('text=admin')).toBeVisible();
});

test('logout redirects to /login', async ({ page }) => {
  await page.goto('http://localhost:5000/');
  // Find the Log out button in the authBar and click it
  await page.click('button:text("Log out")');
  await expect(page).toHaveURL(/\/login/);
});

// ── Admin panel ────────────────────────────────────────────────────────────

test('admin can navigate to /admin', async ({ page }) => {
  await page.goto('http://localhost:5000/admin');
  // Target the tab button specifically (avoids matching the "Users" section heading too)
  await expect(page.getByRole('tab', { name: 'Users' })).toBeVisible();
});

test('admin can create a user and see invite token', async ({ page }) => {
  await page.goto('http://localhost:5000/admin');
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
  await page.goto('http://localhost:5000/admin');
  await page.click('button[role=tab]:text("Settings")');
  await expect(page.locator('#setting-backup-dir')).toBeVisible();
});
