/**
 * Smoke baseline — SolidJS nav screens.
 * Each test: page loads without JS errors, key controls are present.
 */
import { test, expect, type Page } from '@playwright/test';

function jsErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

test('home screen — tiles render', async ({ page }) => {
  const errors = jsErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /manage sets/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /merge sets/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /train/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /analyze/i })).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('manage screen — pair list loads', async ({ page }) => {
  const errors = jsErrors(page);
  await page.goto('/manage');
  await expect(page.getByText('Annotation sets')).toBeVisible();
  await expect(
    page.locator('[data-id]').first().or(page.getByText('No annotation sets yet'))
  ).toBeVisible({ timeout: 5000 });
  expect(errors).toHaveLength(0);
});

test('train screen — pair selector and mode checkboxes render', async ({ page }) => {
  const errors = jsErrors(page);
  await page.goto('/train');
  await expect(page.getByText('Annotation set')).toBeVisible();
  await expect(page.getByText('Polygon drawing')).toBeVisible();
  await expect(page.getByText('Label identification')).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('merge screen — image selector loads', async ({ page }) => {
  const errors = jsErrors(page);
  await page.goto('/merge');
  await expect(page.getByText('Image')).toBeVisible({ timeout: 5000 });
  expect(errors).toHaveLength(0);
});
