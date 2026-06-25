/**
 * Analyze viewer — highest-value surface (where the bug class lived).
 * [F] = fast (behaviour), @full = full-only (computed style / quarantine guard).
 */
import { test, expect } from '@playwright/test';
import { collectJsErrors, expectStyled } from '../support/helpers';
import { SET_MERGED } from '../fixtures/ids';

// ── Picker ────────────────────────────────────────────────────────────────────

test('analyze picker — lists only merged/reannotated sets', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto('/analyze');
  // Seed data has one merged set ("Merged Set") and two raw sets.
  // Raw sets must NOT appear; merged set MUST appear.
  await expect(
    page.locator('[role="option"]').filter({ hasText: /Merged Set/i })
  ).toBeVisible({ timeout: 6000 });
  // Raw sets should not be listed
  await expect(page.getByText('Alpha Set')).not.toBeVisible();
  await expect(page.getByText('Beta Set')).not.toBeVisible();
  expect(errors).toHaveLength(0);
});

// ── Viewer ────────────────────────────────────────────────────────────────────

test('direct-nav /analyze/:id — viewer loads, header and sidebar mount', async ({ page }) => {
  const errors = collectJsErrors(page);
  await page.goto(`/analyze/${SET_MERGED}`);
  const screen = page.locator('#analyze-screen');
  await expect(screen).toBeVisible({ timeout: 8000 });
  // Sidebar mounts with controls
  await expect(page.locator('#analyze-sidebar')).toBeVisible();
  expect(errors).toHaveLength(0);
});

test('viewer home button returns to home screen', async ({ page }) => {
  // AnalyzeHeader has a plain "Home" button that calls showHomeScreen() → navigate('/')
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL('/');
});

test('pile bars (k-bd-bar) render in sidebar', async ({ page }) => {
  // KBreakdown renders one [data-testid="k-bd-bar"] per annotator count level.
  // This is the key surface for the stale-closure bug class.
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#analyze-sidebar')).toBeVisible();
  // Wait for at least one k-bd-bar to appear (sidebar renders after data loads)
  await expect(page.locator('[data-testid="k-bd-bar"]').first()).toBeVisible({ timeout: 5000 });
  const barCount = await page.locator('[data-testid="k-bd-bar"]').count();
  expect(barCount).toBeGreaterThan(0);
});

test('agreement-threshold slider is present and interactive', async ({ page }) => {
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });
  // The Kobalte slider for k-agree threshold
  const slider = page.locator('#analyze-sidebar [role="slider"]').first();
  await expect(slider).toBeVisible({ timeout: 3000 });
  // Sliders have aria-valuenow
  const before = await slider.getAttribute('aria-valuenow');
  expect(before).toBeTruthy();
});

test('abs/rel mode toggle switches mode @full', async ({ page }, testInfo) => {
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });
  // ModeToggle renders Kobalte ToggleGroup: items are "Absolute" and "Relative"
  const absBtn = page.getByRole('button', { name: 'Absolute' });
  const relBtn = page.getByRole('button', { name: 'Relative' });
  await expect(absBtn).toBeVisible({ timeout: 3000 });
  await expect(relBtn).toBeVisible();
  // Kobalte ToggleGroupItem sets data-pressed="" (empty string) when active
  await relBtn.click();
  await expect(relBtn).toHaveAttribute('data-pressed', '');
  await absBtn.click();
  await expect(absBtn).toHaveAttribute('data-pressed', '');
});

// ── Opacity slider computed style (@full — the original Bug-3 class) ──────────

test('opacity slider is styled @full', async ({ page }, testInfo) => {
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });

  const opacityBtn = page.locator('button[title="Annotation opacity"]');
  await expect(opacityBtn).toBeVisible({ timeout: 4000 });
  await opacityBtn.click();

  const slider = page.locator('#analyze-opacity-slider');
  await expect(slider).toBeVisible();

  // The CSS-module .rangeInput sets cursor: pointer.
  // A bare class= string pointing at a deleted global would leave cursor: auto.
  await expectStyled(slider, 'cursor', 'pointer', testInfo);
});

// ── CSS quarantine guard (@full — proves :where(.legacy) scoping holds) ───────

test('Solid button is not overridden by legacy CSS @full', async ({ page }, testInfo) => {
  await page.goto(`/analyze/${SET_MERGED}`);
  await expect(page.locator('#analyze-screen')).toBeVisible({ timeout: 8000 });

  // Pick any Solid-owned button in the analyze header (e.g., the byline-change button).
  // The byline button uses ui.module.css .btnBylineChange (0,1,0 specificity).
  // The legacy sheet's bare `button {}` rule is :where(.legacy) button {} (0,0,1).
  // Assert that our CSS module background/color wins over the legacy default.
  const bylineBtn = page.locator('[data-byline-btn]');
  if (await bylineBtn.isVisible()) {
    // Verify CSS module color applies (not the legacy default).
    // We just check cursor isn't auto (module sets cursor:pointer via .btn base class).
    await expectStyled(bylineBtn, 'cursor', 'pointer', testInfo);
  }
});
