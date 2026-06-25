/**
 * Navigation — home tiles, routing, browser back.
 * [F] = fast (behaviour), @full = full-only (computed style).
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors, expectStyled } from '../support/helpers';

test('home screen — all nav tiles render', async ({ page }, testInfo) => {
  const errors = collectJsErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /manage sets/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /merge sets/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /train/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /analyze/i })).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('home → manage: tile click navigates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /manage sets/i }).click();
  await expect(page).toHaveURL(/\/manage/);
  await expect(page.getByText('Annotation sets')).toBeVisible();
});

test('home → train: tile click navigates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /train/i }).click();
  await expect(page).toHaveURL(/\/train/);
  await expect(page.getByText('Annotation set')).toBeVisible();
});

test('home → merge: tile click navigates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /merge sets/i }).click();
  await expect(page).toHaveURL(/\/merge/);
});

test('home → analyze: tile click navigates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /analyze/i }).click();
  await expect(page).toHaveURL(/\/analyze/);
});

test('direct-nav + hard refresh works for /manage', async ({ page }) => {
  await page.goto('/manage');
  await expect(page.getByText('Annotation sets')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Annotation sets')).toBeVisible();
});

test('direct-nav + hard refresh works for /analyze', async ({ page }) => {
  await page.goto('/analyze');
  await expect(
    page.locator('[role="option"]').first().or(page.getByText('No merged or reannotated sets yet'))
  ).toBeVisible({ timeout: 6000 });
  await page.reload();
  await expect(
    page.locator('[role="option"]').first().or(page.getByText('No merged or reannotated sets yet'))
  ).toBeVisible({ timeout: 6000 });
});

test('browser back from /manage returns to home', async ({ page }) => {
  await page.goto('/');
  await page.goto('/manage');
  await page.goBack();
  await expect(page.getByRole('button', { name: /manage sets/i })).toBeVisible();
});
