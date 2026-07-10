/**
 * TDD spec (Opus-written) for the expired-invite label bug (2026-07-09 testing round).
 * The implementer makes these pass WITHOUT editing this file.
 *
 * Bug: an expired invite renders "Invite (expires expired):" (fmtExpiry returns "expired", spliced
 * into "Invite (expires {expiry})") and STILL shows the invite code + copy buttons. Once expired it
 * should read "Invite (expired)" and hide the code + copy affordances.
 *
 * We mock GET /api/users (via page.route) so we control the invite's `expires` precisely — no DB or
 * clock manipulation. `page` is pre-authenticated as admin.
 */
import { test, expect, type Route } from '@playwright/test';

type MockUser = { id: number; username: string; has_password: boolean; invite: { token: string; expires: number } };

function mockUsers(users: MockUser[]) {
  return async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(users) });
    } else {
      await route.continue();
    }
  };
}

test('EXPIRED invite: reads "expired" (not "expires expired") and hides the code + copy buttons', async ({ page }) => {
  const past = Math.floor(Date.now() / 1000) - 100;
  await page.route('**/api/users', mockUsers([
    { id: 42, username: 'expiredUser', has_password: false, invite: { token: 'TOK-EXPIRED-42', expires: past } },
  ]));
  await page.goto('/admin');
  await expect(page.getByText('expiredUser')).toBeVisible({ timeout: 5000 });

  // The doubled-word bug is gone (this is the current buggy render — must not appear).
  await expect(page.getByText(/expires expired/i)).toHaveCount(0);
  // No invite code + no copy affordances once expired.
  await expect(page.getByText('TOK-EXPIRED-42')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /copy code/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /copy link/i })).toHaveCount(0);
});

test('LIVE invite: shows the expiry label + the code copy buttons (regression guard)', async ({ page }) => {
  const future = Math.floor(Date.now() / 1000) + 86_400;
  await page.route('**/api/users', mockUsers([
    { id: 43, username: 'liveUser', has_password: false, invite: { token: 'TOK-LIVE-43', expires: future } },
  ]));
  await page.goto('/admin');
  await expect(page.getByText('liveUser')).toBeVisible({ timeout: 5000 });

  // A live invite keeps the "expires …" label + the copy buttons.
  await expect(page.getByText(/invite \(expires/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /copy code/i })).toBeVisible();
});
