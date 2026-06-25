import { type Locator, type TestInfo } from '@playwright/test';

/**
 * Assert a computed CSS property — runs only in the `full` project.
 * In `fast`, this is a no-op so the same spec body works for both tiers.
 */
export async function expectStyled(
  locator: Locator,
  prop: string,
  value: string,
  testInfo: TestInfo,
): Promise<void> {
  if (testInfo.project.name !== 'full') return;
  const actual = await locator.evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p),
    prop,
  );
  if (actual !== value) {
    throw new Error(
      `expectStyled: ${prop} expected "${value}", got "${actual}" (${await locator.textContent()})`,
    );
  }
}

/** Collect JS errors on the page. Pass the returned array to expect().toHaveLength(0) at end. */
export function collectJsErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}
