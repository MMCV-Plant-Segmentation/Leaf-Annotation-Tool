/**
 * Merge screen — image selector, set checkboxes, Continue.
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors } from '../support/helpers';

test('merge screen loads with Image heading', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto('/merge');
  await expect(page.getByText('Image')).toBeVisible({ timeout: 5000 });
  expect(errors).toHaveLength(0);
});

test('image selector shows sets grouped by image hash', async ({ page }) => {
  await page.goto('/merge');
  // The image selector is a Kobalte Listbox; seed data has one image hash
  await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });
});

test('selecting an image shows raw-set checkboxes', async ({ page }) => {
  await page.goto('/merge');
  const option = page.locator('[role="option"]').first();
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.click();
  // After selection, raw-set checkboxes appear (Alpha Set, Beta Set).
  // Use first() because the image option itself may also contain the name text.
  await expect(page.getByText('Alpha Set').first()).toBeVisible({ timeout: 3000 });
  await expect(page.getByText('Beta Set').first()).toBeVisible();
});

test('selecting two sets enables the Continue button', async ({ page }) => {
  await page.goto('/merge');
  await page.locator('[role="option"]').first().click();
  // Kobalte Checkbox renders CheckboxRoot as role="group"; check by text filter
  const alphaChk = page.locator('[role="group"]').filter({ hasText: /Alpha Set/i });
  const betaChk  = page.locator('[role="group"]').filter({ hasText: /Beta Set/i });
  await expect(alphaChk.first()).toBeVisible({ timeout: 3000 });
  await alphaChk.first().click();
  await betaChk.first().click();
  const continueBtn = page.getByRole('button', { name: /continue/i });
  await expect(continueBtn).toBeEnabled({ timeout: 2000 });
});
