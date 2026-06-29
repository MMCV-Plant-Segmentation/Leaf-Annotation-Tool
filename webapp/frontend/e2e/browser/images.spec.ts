/**
 * Browser e2e tests for the images sub-screen:
 *   I1. Sequential per-file upload: 3 files → 3 separate POSTs + "Uploading N of M" label
 *   I2. Dedup: re-uploading same files shows aggregate skipped count
 *   I3. Admin gate: server-path section hidden for non-admin, visible for admin
 *   I4. Invite logout: visiting an invite URL while logged in as admin clears the session
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FLAT_IMAGES = [
  path.join(FIXTURE_DIR, 'flat-images', 'upload0.png'),
  path.join(FIXTURE_DIR, 'flat-images', 'upload1.png'),
  path.join(FIXTURE_DIR, 'flat-images', 'upload2.png'),
];

// ── I1: Sequential per-file upload ──────────────────────────────────────────

test('I1: sequential upload — 3 files → 3 POSTs + aggregate imported=3', async ({ page }) => {
  // Create a fresh project for this test.
  const projResp = await page.request.post('/api/projects', { data: { name: 'Upload e2e test' } });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // Count upload POSTs to verify sequential (one per file) behaviour.
  const uploadUrls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/images/upload') && req.method() === 'POST') {
      uploadUrls.push(req.url());
    }
  });

  await page.locator('[data-testid="import-files"]').setInputFiles(FLAT_IMAGES);
  await page.click('[data-testid="upload-btn"]');

  // "Uploading N of M" should appear in the progress label during transfer.
  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 5000 });
  // Eventually the label transitions to per-file progress; wait for the summary.
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  const summaryText = await page.getByTestId('import-summary').textContent();
  expect(summaryText).toContain('Imported 3');
  expect(summaryText).toContain('skipped 0');

  // Three separate POSTs (sequential, not one multipart with all files).
  expect(uploadUrls).toHaveLength(3);
});

// ── I2: Dedup ────────────────────────────────────────────────────────────────

test('I2: dedup — re-uploading same files shows skipped=3', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'Dedup e2e test' } });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // First upload — all imported.
  await page.locator('[data-testid="import-files"]').setInputFiles(FLAT_IMAGES);
  await page.click('[data-testid="upload-btn"]');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText('Imported 3');

  // Second upload — all skipped (same bytes).
  await page.locator('[data-testid="import-files"]').setInputFiles(FLAT_IMAGES);
  await page.click('[data-testid="upload-btn"]');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  const summary2 = await page.getByTestId('import-summary').textContent();
  expect(summary2).toContain('Imported 0');
  expect(summary2).toContain('skipped 3');
});

// ── I3: Admin gate — server-path section ────────────────────────────────────

test('I3: admin sees server-path section; non-admin does not', async ({ page, browser }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'Gate visibility test' } });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  // Admin (default storageState) should see the section.
  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('serverPathSection')).toBeVisible();

  // Non-admin: create a fresh user via the admin API, set their password,
  // then log in with a new browser context.
  const username = `gate-user-${Date.now()}`;
  const createResp = await page.request.post('/api/users', { data: { username } });
  expect(createResp.ok()).toBeTruthy();
  const { invite } = (await createResp.json()) as { invite: { token: string } };

  // Accept the invite (no auth required) to set the user's password.
  // NOTE: api_accept_invite clears the caller's session; we use a throwaway request
  // from a separate context so the admin page session is not affected.
  const pw = 'TestPass99!';
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonPage = await anonCtx.newPage();
  const acceptResp = await anonPage.request.post(`/api/invite/${invite.token}`, {
    data: { password: pw, confirm: pw },
  });
  expect(acceptResp.ok()).toBeTruthy(); // password must be set before login
  await anonCtx.close();

  // Log in as the non-admin in another fresh context.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p2  = await ctx.newPage();
  await p2.goto('/login');
  await p2.fill('#login-username', username);
  await p2.fill('#login-password', pw);
  await p2.click('button[type=submit]');
  // window.location.href='/' triggers a full page reload; wait for auth bar to confirm login.
  await expect(p2.getByTestId('auth-username')).toBeVisible({ timeout: 8000 });

  await p2.goto(`/projects/${id}/images`);
  await expect(p2.getByTestId('upload-btn')).toBeVisible({ timeout: 5000 });
  // Non-admin: serverPathSection must be absent from the DOM.
  await expect(p2.getByTestId('serverPathSection')).not.toBeVisible();
  await ctx.close();
});

// ── I4: Invite logout ────────────────────────────────────────────────────────

test('I4: visiting invite URL while logged in as admin clears the session', async ({ page }) => {
  // Admin is logged in (storageState from globalSetup).
  await page.goto('/');
  await expect(page.getByTestId('auth-username')).toBeVisible();

  // Create a test user to get a fresh invite token via the admin API.
  const username = `invite-logout-${Date.now()}`;
  const resp = await page.request.post('/api/users', { data: { username } });
  const { invite } = (await resp.json()) as { invite: { token: string } };

  // Navigate to the invite URL. InviteScreen calls logout + fetchMe on mount;
  // api_get_invite also clears the server session.
  await page.goto(`/invite/${invite.token}`);

  // Wait for the invite page to fully render (form or error).
  await expect(
    page.getByRole('heading').first(),
  ).toBeVisible({ timeout: 5000 });

  // Session must be cleared: /api/me should return null.
  const meResp = await page.request.get('/api/me');
  const me = await meResp.json() as null | { username: string };
  expect(me).toBeNull();

  // Navigating to a protected page should redirect to /login.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
});
