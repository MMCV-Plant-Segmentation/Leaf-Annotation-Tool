/**
 * t108: a fresh project's default compound is UN-named and DERIVES its label from the
 * member out of the box — so renaming the member flows straight through to the paint
 * palette with no need to first clear a custom name. (t89's derive, applied to the seed.)
 */
import { test, expect } from '@playwright/test';

type Out = { compounds?: { id: string; name: string }[]; classes?: { name: string }[] };
const read = async (page: import('@playwright/test').Page, id: string): Promise<Out> =>
  (await (await page.request.get(`/api/projects/${id}`)).json()) as Out;

test('t108: default compound is empty-named + derives; member rename tracks the palette', async ({ page }) => {
  const { id } = (await (await page.request.post('/api/projects', { data: { name: `T108 ${Date.now()}` } })).json()) as { id: string };

  // Out of the box: the default compound carries NO custom name, and the palette derives 'thing'.
  const seed = await read(page, id);
  expect(seed.compounds?.[0]?.name).toBe('');
  expect(seed.classes?.map((c) => c.name)).toEqual(['thing']);

  // Rename the member 'thing' → 'blah' via the editor; the derived palette label must follow.
  await page.goto(`/projects/${id}/labels`);
  await expect(page.getByTestId('label-editor')).toBeVisible({ timeout: 5000 });
  // The editor row shows the derived label before any edit.
  await expect(page.getByTestId('compound-row').first()).toContainText('thing');

  await page.getByTestId('member-name').first().fill('blah');
  await expect(page.getByTestId('label-save')).toBeEnabled();
  await page.getByTestId('label-save').click();

  await expect.poll(async () => (await read(page, id)).classes?.[0]?.name, { timeout: 5000 }).toBe('blah');
  // Still un-named (the label tracks the member, not a stored string).
  expect((await read(page, id)).compounds?.[0]?.name).toBe('');
});
