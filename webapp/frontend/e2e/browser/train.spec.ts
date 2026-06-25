/**
 * Train screen — pair selector, mode checkboxes, count slider.
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors } from '../support/helpers';
import { SET_ALPHA } from '../fixtures/ids';

test('pair selector, mode checkboxes, count slider all render', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto('/train');
  await expect(page.getByText('Annotation set')).toBeVisible();
  await expect(page.getByText('Polygon drawing')).toBeVisible();
  await expect(page.getByText('Label identification')).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('Kobalte Listbox shows seeded raw sets', async ({ page }) => {
  await page.goto('/train');
  // The pair picker is a Kobalte Listbox; options appear as [role="option"]
  await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 5000 });
  // Alpha Set and Beta Set should be in the list (raw sets only)
  await expect(page.getByText('Alpha Set')).toBeVisible();
  await expect(page.getByText('Beta Set')).toBeVisible();
});

test('first set is auto-selected and Start Training button is enabled', async ({ page }) => {
  // TrainScreen.onMount auto-selects the first trainable pair (trainable[0].id).
  // With seed data (Alpha Set, Beta Set), Alpha Set should be pre-selected.
  await page.goto('/train');
  const option = page.locator('[role="option"]').filter({ hasText: /Alpha Set/i });
  await expect(option).toBeVisible({ timeout: 5000 });
  // Kobalte uses data-selected="" (empty string) on selected options
  await expect(option).toHaveAttribute('data-selected', '');
  // The config-view button is "Start Training" (not "Continue" — that's the fork/resume view)
  const startBtn = page.getByRole('button', { name: /start training/i });
  await expect(startBtn).toBeEnabled({ timeout: 2000 });
});

test('mode checkboxes are interactive', async ({ page }) => {
  await page.goto('/train');
  // Kobalte Checkbox renders CheckboxRoot as role="group"; text is sibling content
  const polyChk  = page.locator('[role="group"]').filter({ hasText: /polygon drawing/i });
  const labelChk = page.locator('[role="group"]').filter({ hasText: /label identification/i });
  await expect(polyChk.first()).toBeVisible({ timeout: 5000 });
  await expect(labelChk.first()).toBeVisible();
  // Toggle polygon off then on
  await polyChk.first().click();
  await polyChk.first().click();
});
