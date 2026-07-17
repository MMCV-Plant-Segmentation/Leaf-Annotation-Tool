/**
 * Browser e2e tests for the images sub-screen:
 *   I1. Sequential per-file upload: 3 files → 3 separate POSTs + "Uploading N of M" label
 *   I2. Dedup: re-uploading same files shows aggregate skipped count
 *   I3. Admin gate: server-path section hidden for non-admin, visible for admin
 *   I4. Invite logout: visiting an invite URL while logged in as admin clears the session
 *   I5. Progress total reflects the SELECTED file count immediately (before hashing
 *       resolves) and a distinct "hashing/preparing" phase is visible.
 *   I6. A new+already-present mix still reaches 100% (skipped files fast-forward `done`).
 *   I7. The grid populates progressively during upload, not only after it finishes.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { uniquePngs } from './uploadFixtures';

const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FLAT_DIR = path.join(FIXTURE_DIR, 'flat-images');

// ── I1: Parallel per-file upload (≤4 concurrent) ─────────────────────────────

test('I1: parallel upload — 3 files → 3 POSTs (one per file) + aggregate imported=3', async ({ page }) => {
  // Create a fresh project for this test.
  const projResp = await page.request.post('/api/projects', { data: { name: 'Upload e2e test' } });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // Count upload POSTs: there should be exactly one POST per file (one per file, ≤4 concurrent).
  const uploadUrls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/images/upload') && req.method() === 'POST') {
      uploadUrls.push(req.url());
    }
  });

  // Bytes unique to THIS test — global dedup would otherwise skip images another test uploaded.
  await page.locator('[data-testid="import-files"]').setInputFiles(uniquePngs(FLAT_DIR, 'images-i1', 3));
  await page.click('[data-testid="upload-btn"]');

  // Progress label and summary must appear.
  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  const summaryText = await page.getByTestId('import-summary').textContent();
  expect(summaryText).toContain('Imported 3');
  expect(summaryText).toContain('skipped 0');

  // Still one POST per file (pool drains the queue; not one multipart with all files).
  expect(uploadUrls).toHaveLength(3);
});

// ── I2: Dedup ────────────────────────────────────────────────────────────────

test('I2: dedup — re-uploading same files shows skipped=3', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'Dedup e2e test' } });
  expect(projResp.ok()).toBeTruthy();
  const { id } = (await projResp.json()) as { id: string };

  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // Bytes unique to THIS test, reused across both uploads so the SECOND is the dedup path.
  const files = uniquePngs(FLAT_DIR, 'images-i2', 3);

  // First upload — all imported.
  await page.locator('[data-testid="import-files"]').setInputFiles(files);
  await page.click('[data-testid="upload-btn"]');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText('Imported 3');

  // Second upload — all skipped (same bytes).
  await page.locator('[data-testid="import-files"]').setInputFiles(files);
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
  const username = `gateuser-${Date.now()}`;
  const createResp = await page.request.post('/api/users', { data: { username } });
  expect(createResp.ok()).toBeTruthy();
  const newUser = await createResp.json() as { id: number; invite: { token: string } };
  const { invite } = newUser;

  // Add the non-admin as a project member so they can access the images screen.
  // (Fix 3 requires membership; the server-path section visibility depends on is_admin, not membership.)
  const addResp = await page.request.post(`/api/projects/${id}/annotators`, {
    data: { user_id: newUser.id },
  });
  expect(addResp.ok()).toBeTruthy();

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
  // Non-admin (but project member): serverPathSection must be absent from the DOM.
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

  // Navigate to the invite URL. InviteScreen fetches /api/invite/:token on mount
  // (clears the server session) and separately POSTs /api/logout. Wait for the
  // invite page to render its heading — that only appears after the invite GET
  // completes, by which point the session is cleared.
  await page.goto(`/invite/${invite.token}`);

  // Wait for the invite page to fully render (heading appears after invite GET completes).
  await expect(
    page.getByRole('heading').first(),
  ).toBeVisible({ timeout: 5000 });

  // Retry until the session is confirmed null — absorbs any residual async lag
  // between the invite-GET session clear and the subsequent /api/me check.
  await expect(async () => {
    const r = await page.request.get('/api/me');
    const me = await r.json() as null | { username: string };
    expect(me).toBeNull();
  }).toPass({ timeout: 5000 });

  // Navigating to a protected page should redirect to /login.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
});

// ── I5: total shows the SELECTED count immediately + a hashing phase ────────────

test('I5: total is "N" immediately and a hashing/preparing phase is visible', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'ProgressPhase e2e' } });
  const { id } = (await projResp.json()) as { id: string };
  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // Client-side hashing of 3 tiny fixture PNGs is near-instant; delay the probe
  // round-trip so the transient "hashing" phase has time to be observed.
  await page.route('**/images/probe', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });

  await page.locator('[data-testid="import-files"]').setInputFiles(uniquePngs(FLAT_DIR, 'images-i5', 3));
  await page.click('[data-testid="upload-btn"]');

  // Total reflects the SELECTED count immediately — no "0/0" silent phase.
  await expect(page.getByTestId('import-progress-label')).toContainText('/ 3', { timeout: 2000 });
  await expect(page.getByTestId('import-phase-label')).toBeVisible({ timeout: 2000 });

  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
});

// ── I6: a new+already-present mix still reaches 100% ────────────────────────────

test('I6: new+already-present mix reaches 100% and summarizes both', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'MixProgress e2e' } });
  const { id } = (await projResp.json()) as { id: string };
  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  const preExisting = uniquePngs(FLAT_DIR, 'images-i6-pre', 2);
  await page.locator('[data-testid="import-files"]').setInputFiles(preExisting);
  await page.click('[data-testid="upload-btn"]');
  await expect(page.getByTestId('import-summary')).toContainText('Imported 2', { timeout: 15000 });

  // Re-upload the 2 already-present files alongside 1 genuinely new one.
  const fresh = uniquePngs(FLAT_DIR, 'images-i6-fresh', 1);
  await page.locator('[data-testid="import-files"]').setInputFiles([...preExisting, ...fresh]);
  await page.click('[data-testid="upload-btn"]');

  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
  const summaryText = await page.getByTestId('import-summary').textContent();
  expect(summaryText).toContain('Imported 1');
  expect(summaryText).toContain('skipped 2');

  // The bar reaches exactly 100% width (not stalled short by the dedup skips).
  const width = await page.getByTestId('import-progress-bar')
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toBe('100%');
});

// ── I7: the grid populates progressively during upload ──────────────────────────

test('I7: the grid refetches progressively during upload, not just once at the end', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'Progressive e2e' } });
  const { id } = (await projResp.json()) as { id: string };
  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible();

  // Slow each upload POST down so successive per-file completions are spread out in
  // wall-clock time — otherwise all 4 concurrent uploads would land in one lump.
  await page.route('**/images/upload', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });

  // Count GETs to the project-detail endpoint from AFTER the initial page load only.
  let getCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith(`/api/projects/${id}`)) getCount += 1;
  });

  // 8 files vs. a 4-concurrent upload pool -> multiple per-file completions spread
  // over time, giving the debounced mid-upload reload real windows to fire.
  await page.locator('[data-testid="import-files"]').setInputFiles(uniquePngs(FLAT_DIR, 'images-i7', 8));
  await page.click('[data-testid="upload-btn"]');

  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('lazy-image-grid').locator('li')).toHaveCount(8, { timeout: 5000 });

  // More than the ONE final refetch after completion — proves a reload also fired
  // WHILE the upload was still running (the debounced mid-upload reload).
  await expect.poll(() => getCount, { timeout: 3000 }).toBeGreaterThan(1);
});

// ── I8: the label editor lives on its own /labels route, reachable from the hub ──

test('I8: label editor is on its own /labels route, reachable from the hub, absent elsewhere', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: 'LabelHub e2e' } });
  const { id } = (await projResp.json()) as { id: string };

  // Hub: the editor is no longer embedded here — a "Labels" step card links to its route.
  await page.goto(`/projects/${id}`);
  await expect(page.getByTestId('label-editor')).toHaveCount(0);
  await page.getByTestId('card-labels').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}/labels`));
  await expect(page.getByTestId('label-editor')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('label-edit')).toBeVisible();

  // Images screen: still no editor.
  await page.goto(`/projects/${id}/images`);
  await expect(page.getByTestId('upload-btn')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('label-editor')).toHaveCount(0);
});
