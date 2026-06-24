/**
 * Smoke baseline — Analyze screens.
 * Covers: setup picker, viewer route, and the opacity-slider computed-style
 * (this class of check would have caught Bug 3 before it shipped).
 */
import { test, expect, type Page } from '@playwright/test';

function jsErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

test('analyze setup — picker loads', async ({ page }) => {
  const errors = jsErrors(page);
  await page.goto('/analyze');
  await expect(
    page.locator('[role="option"]').first().or(
      page.getByText('No merged or reannotated sets yet')
    )
  ).toBeVisible({ timeout: 6000 });
  expect(errors).toHaveLength(0);
});

test('analyze viewer — screen visible, opacity slider styled', async ({ page }) => {
  // Find a merged/reannotated set to navigate to.
  await page.goto('/analyze');
  const sets: Array<{ id: string; kind: string }> = await page.evaluate(() =>
    fetch('/api/images').then(r => r.json())
  );
  const target = sets.find(s => s.kind === 'merged' || s.kind === 'reannotated');
  if (!target) {
    test.skip(true, 'no merged/reannotated set — skipping viewer smoke');
    return;
  }

  const errors = jsErrors(page);
  await page.goto(`/analyze/${target.id}`);

  // #analyze-screen is shown by AnalyzeViewerRoute.onMount after fetchAnalyze() resolves.
  const screen = page.locator('#analyze-screen');
  await expect(screen).toBeVisible({ timeout: 5000 });

  // Open the opacity popup (rendered by SolidJS AnalyzeHeader into #analyze-header-right).
  const opacityBtn = page.locator('button[title="Annotation opacity"]');
  await expect(opacityBtn).toBeVisible({ timeout: 4000 });
  await opacityBtn.click();

  // Assert the slider is styled by its CSS module.
  // A bare class="range-input" pointing at a deleted global would leave cursor at 'auto'.
  // After the Bug 3 fix, AnalyzeHeader.module.css .rangeInput sets cursor: pointer.
  const slider = page.locator('#analyze-opacity-slider');
  await expect(slider).toBeVisible();
  const cursor = await slider.evaluate(el => getComputedStyle(el).cursor);
  expect(cursor).toBe('pointer');

  expect(errors).toHaveLength(0);
});
