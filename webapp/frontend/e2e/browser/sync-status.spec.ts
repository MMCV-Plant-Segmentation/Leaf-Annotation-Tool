/**
 * Admin sync-status card (docs/plans/Plan — Admin sync-status panel.md): GET
 * /api/sync-status is mocked here so the three freshness states (fresh/green,
 * stale amber+red, not-configured) render correctly without a real backup profile
 * — the ephemeral gate server never runs the backup sidecars.
 */
import { test, expect } from '@playwright/test';
import { expectStyled } from '../support/helpers';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/admin');
  await expect(page.getByTestId('auth-username')).toBeVisible();
  await page.click('button[role=tab]:text("Settings")');
}

test('not configured renders the "not configured" state', async ({ page }) => {
  await page.route('**/api/sync-status', (route) =>
    route.fulfill({ json: { configured: false } }),
  );
  await openSettings(page);
  await expect(page.getByTestId('sync-status-card')).toBeVisible();
  await expect(page.getByTestId('sync-status-not-configured')).toBeVisible();
});

test('fresh backups render ages with the green pill', async ({ page }, testInfo) => {
  await page.route('**/api/sync-status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        ok: true,
        db: { lastSyncIso: new Date().toISOString(), ageSec: 60 },
        files: { lastSyncIso: new Date().toISOString(), ageSec: 120 },
      },
    }),
  );
  await openSettings(page);
  const db = page.getByTestId('sync-status-db');
  await expect(db).toContainText('ago');
  await expect(page.getByTestId('sync-status-files')).toContainText('ago');
  await expectStyled(db, 'font-weight', '600', testInfo);
});

test('stale DB (amber) and very stale files (red) render differently', async ({ page }, testInfo) => {
  await page.route('**/api/sync-status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        ok: true,
        db: { lastSyncIso: new Date().toISOString(), ageSec: 3600 }, // 1h -> amber
        files: { lastSyncIso: new Date().toISOString(), ageSec: 999999 }, // ~11d -> red
      },
    }),
  );
  await openSettings(page);
  const db = page.getByTestId('sync-status-db');
  const files = page.getByTestId('sync-status-files');
  await expect(db).toContainText('h ago');
  await expect(files).toContainText('d ago');

  if (testInfo.project.name === 'full') {
    const dbColor = await db.evaluate((el) => getComputedStyle(el).color);
    const filesColor = await files.evaluate((el) => getComputedStyle(el).color);
    expect(dbColor).not.toBe(filesColor);
  }
});
