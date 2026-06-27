// TDD browser acceptance — ACTIVATE at:  e2e/browser/theme.spec.ts  (runs in @full)
// Computed-style + reflow guards for the theme migration. Uses the global admin storageState.
// Requires Sonnet to: apply the dark theme class to <body>, and add a theme toggle with
// data-testid="theme-toggle" (Phase 3) that flips body to the light theme + persists to localStorage.
import { test, expect } from '@playwright/test';

const DARK_BG = 'rgb(17, 19, 24)'; // #111318 — the dark `bg` token (unchanged by the migration)
const WIDTHS = [1280, 768, 400];   // desktop, tablet, WCAG-reflow width (a11y arc reuses 400)
const ROUTES = ['/', '/admin', '/projects'];

test.describe('@full theme', () => {
  test('body uses the dark theme background by default', async ({ page }) => {
    await page.goto('/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(DARK_BG);
  });

  test('theme toggle switches to light and persists', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).not.toBe(DARK_BG);
    // persists across reload
    await page.reload();
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(after).toBe(light);
  });

  for (const route of ROUTES) {
    for (const w of WIDTHS) {
      test(`no horizontal overflow on ${route} @ ${w}px`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        await page.goto(route);
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'content spills past the viewport').toBeLessThanOrEqual(1);
      });
    }
  }
});
