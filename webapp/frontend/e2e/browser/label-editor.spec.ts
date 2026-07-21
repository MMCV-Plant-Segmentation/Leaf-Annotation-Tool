/**
 * Browser e2e for the per-project taxonomy editor's SAVE model (t73–t76 rework, t90).
 *
 *   t74 — ONE Save button flushes the in-progress compound rename THEN persists; renaming
 *         an existing compound and clicking the single Save (no inner "save compound")
 *         must survive a reload. (Was the two-step-save discard bug.)
 *   t76 — Save is DISABLED on open (no changes) and ENABLED once the draft is dirty.
 *   t90 — the /labels editor is ALWAYS open (no Edit step) and does NOT collapse on Save;
 *         after saving it stays open, reflects the saved state, and Save re-disables.
 *
 * Property/DOM assertions only (no pixel checks); persistence is verified via the API read
 * so the assertion doesn't depend on how the editor re-renders after a reload.
 */
import { test, expect } from '@playwright/test';

type CompoundOut = { id: string; name: string; color: string };

const compoundNames = async (page: import('@playwright/test').Page, id: string): Promise<string[]> => {
  const r = await page.request.get(`/api/projects/${id}`);
  const j = (await r.json()) as { compounds?: CompoundOut[] };
  return (j.compounds ?? []).map((c) => c.name);
};

test('t74/t76/t90: single Save flushes a rename; dirty-gated; editor stays open on save', async ({ page }) => {
  const projResp = await page.request.post('/api/projects', { data: { name: `LabelSave ${Date.now()}` } });
  const { id } = (await projResp.json()) as { id: string };

  // Fresh project seeds one default compound named 'thing'.
  expect(await compoundNames(page, id)).toContain('thing');

  // t90: no Edit step — the editor is open immediately on the /labels route.
  await page.goto(`/projects/${id}/labels`);
  await expect(page.getByTestId('label-editor')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('label-save')).toBeVisible();

  // t76: nothing changed yet → Save disabled.
  await expect(page.getByTestId('label-save')).toBeDisabled();

  // Edit the existing compound's name via the single (outer) Save flow — no inner save.
  await page.getByTestId('compound-edit').first().click();
  const nameInput = page.getByTestId('compound-name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('renamed-leaf');

  // t76: the pending rename makes the draft dirty → Save enabled.
  await expect(page.getByTestId('label-save')).toBeEnabled();

  // t74: the SINGLE Save flushes the pending edit and persists it.
  await page.getByTestId('label-save').click();

  // t90: editor STAYS open on save (no collapse) and reflects the saved state — Save is
  // present and re-disables once the draft matches the persisted taxonomy again.
  await expect(page.getByTestId('label-save')).toBeVisible();
  await expect(page.getByTestId('label-save')).toBeDisabled({ timeout: 5000 });
  await expect(page.getByTestId('compound-row').filter({ hasText: 'renamed-leaf' })).toBeVisible();

  // Persisted through a real read.
  await expect.poll(() => compoundNames(page, id), { timeout: 5000 }).toContain('renamed-leaf');
  expect(await compoundNames(page, id)).not.toContain('thing');
});
