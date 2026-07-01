/**
 * Stack-wide version identity (docs/plans/Plan — Version everything (stack-wide).md):
 * the app-shell footer and the admin Settings version card both surface GET /api/version.
 */
import { test, expect } from '@playwright/test';

test('app-shell footer shows the build identity', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-username')).toBeVisible(); // app-ready before asserting
  const footer = page.getByTestId('version-footer');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText(/^v\S+ · \S+$/);
});

test('admin Settings panel shows the full version readout', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByTestId('auth-username')).toBeVisible();
  await page.click('button[role=tab]:text("Settings")');
  const card = page.getByTestId('version-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('version-card-appVersion')).not.toBeEmpty();
  await expect(page.getByTestId('version-card-gitSha')).not.toBeEmpty();
  await expect(page.getByTestId('version-card-builtAt')).not.toBeEmpty();
  await expect(page.getByTestId('version-card-schemaVersion')).not.toBeEmpty();
});
