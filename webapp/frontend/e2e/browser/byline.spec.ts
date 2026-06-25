/**
 * Byline modal — first-load mandatory, name stored in localStorage, header button visible.
 *
 * The byline is stored in localStorage under 'lesion-user'.
 * Vanilla app.js renders the user's name as the textContent of every .btn-byline-change button.
 * These vanilla buttons are in the static HTML and get synced at init (before Solid renders).
 * The Solid-rendered [data-byline-btn] in AnalyzeHeader is the change-name icon button:
 * it has no text (it's a styled icon button), but it IS visible and clickable in the viewer.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { SET_MERGED } from '../fixtures/ids';

/** Open a context with NO pre-seeded byline (overrides config storageState). */
async function freshContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

test('first load with no stored user — mandatory modal blocks the app', async ({ browser }) => {
  const ctx  = await freshContext(browser);
  const page = await ctx.newPage();
  await page.goto('http://localhost:5000/');
  // The byline modal is mandatory — the name input is visible
  const input = page.getByPlaceholder(/your name/i).or(page.getByRole('textbox'));
  await expect(input.first()).toBeVisible({ timeout: 5000 });
  await ctx.close();
});

test('enter name — modal dismisses and name is stored in localStorage', async ({ browser }) => {
  const ctx  = await freshContext(browser);
  const page = await ctx.newPage();
  await page.goto('http://localhost:5000/');
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible({ timeout: 5000 });
  await input.fill('TestUser');
  await page.keyboard.press('Enter');
  // Modal closes
  await expect(input).not.toBeVisible({ timeout: 3000 });
  // Name is persisted in localStorage
  const stored = await page.evaluate(() => localStorage.getItem('lesion-user'));
  expect(stored).toBe('TestUser');
  // Persists across reload
  await page.reload();
  const storedAfterReload = await page.evaluate(() => localStorage.getItem('lesion-user'));
  expect(storedAfterReload).toBe('TestUser');
  // Byline modal does NOT reappear (name already set)
  await expect(page.getByRole('textbox')).not.toBeVisible({ timeout: 2000 });
  await ctx.close();
});

test('byline change button visible in analyze viewer', async ({ page }) => {
  // AnalyzeHeader renders [data-byline-btn] — an icon-style button to open the change-name modal.
  // It exists and is visible whenever the analyze viewer is shown.
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });
  const bylineBtn = page.locator('[data-byline-btn]');
  await expect(bylineBtn).toBeVisible({ timeout: 3000 });
});
