/**
 * Manage screen — set list, kind tags, rename.
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors } from '../support/helpers';
import { SET_ALPHA, SET_BETA, SET_MERGED } from '../fixtures/ids';

test('set list renders the seeded sets', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto('/manage');
  await expect(page.getByText('Alpha Set')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Beta Set')).toBeVisible();
  await expect(page.getByText('Merged Set')).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('set-kind tags are present on each row', async ({ page }) => {
  await page.goto('/manage');
  await expect(page.locator(`[data-id="${SET_ALPHA}"]`)).toBeVisible({ timeout: 5000 });
  // Kind text ("raw" / "merged") is inside a <span> within each row
  await expect(page.locator(`[data-id="${SET_ALPHA}"] span:has-text("raw")`).first()).toBeVisible();
  await expect(page.locator(`[data-id="${SET_BETA}"] span:has-text("raw")`).first()).toBeVisible();
  await expect(page.locator(`[data-id="${SET_MERGED}"] span:has-text("merged")`).first()).toBeVisible();
});

test('rename: inline edit persists across refresh', async ({ page }) => {
  await page.goto('/manage');
  const row = page.locator(`[data-id="${SET_ALPHA}"]`);
  await expect(row).toBeVisible({ timeout: 5000 });

  // The rename button has title="Rename" and text ✎
  const editBtn = row.locator('button[title="Rename"]');
  await editBtn.click();

  // Input appears in place of the name
  const nameInput = row.locator('input[type="text"]');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('Alpha Renamed');
  await nameInput.press('Enter');

  await expect(page.getByText('Alpha Renamed')).toBeVisible({ timeout: 3000 });
  await page.reload();
  await expect(page.getByText('Alpha Renamed')).toBeVisible({ timeout: 5000 });

  // Restore
  const row2 = page.locator(`[data-id="${SET_ALPHA}"]`);
  await row2.locator('button[title="Rename"]').click();
  const input2 = row2.locator('input[type="text"]');
  await input2.fill('Alpha Set');
  await input2.press('Enter');
  await expect(page.getByText('Alpha Set')).toBeVisible();
});

test('data-id attributes present for all rows', async ({ page }) => {
  await page.goto('/manage');
  await expect(page.locator(`[data-id="${SET_ALPHA}"]`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-id="${SET_BETA}"]`)).toBeVisible();
  await expect(page.locator(`[data-id="${SET_MERGED}"]`)).toBeVisible();
});
