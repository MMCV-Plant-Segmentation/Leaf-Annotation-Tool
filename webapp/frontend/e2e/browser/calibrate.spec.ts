/**
 * t157 — input-calibration page. Draws one mouse stroke on the pad and reads the page's own
 * report. Also a regression guard for the doubled-sample bug: the app's delegated pointer path
 * must see exactly as many move events as a direct listener (no double delivery).
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors } from '../support/helpers';

test('calibrate — a stroke yields a report; app path sees each move once', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto('/calibrate');
  const pad = page.getByTestId('calibrate-pad');
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 12 });
  await page.mouse.up();

  const report = page.getByTestId('calibrate-report');
  await expect(report).toBeVisible();
  const r = JSON.parse(await report.inputValue());
  expect(r.pointerType).toBe('mouse');
  expect(r.moveEvents).toBeGreaterThan(0);
  expect(r.delegatedMoves).toBe(r.moveEvents);
  expect(r.duplicateMoves).toBe(0);
  expect(r.api).toHaveProperty('coalesced');
  expect(errors).toHaveLength(0);
});

test('calibrate — Back returns to the previous page', async ({ page }) => {
  await page.goto('/projects');
  await page.goto('/calibrate');
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/projects$/);
});
