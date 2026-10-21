import { expect, test } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { mockApi, setPrefs } from './support/mock-api';

// L12 (design review): on a phone the not-found page's primary button ran past its panel's padding with a Ctrl K hint
// nobody can press there. Below sm the hint is gone and the button fits; on a laptop the hint stays.

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page);
  await setPrefs(page, { theme: 'steel' });
});

for (const { width, hint } of [
  { width: 390, hint: false },
  { width: 1440, hint: true },
]) {
  test(`not-found page · ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/nowhere/at-all');
    const main = page.getByRole('main');
    const button = main.getByRole('button', { name: /Open the command palette/ });
    await expect(button).toBeVisible();
    const kbd = button.locator('kbd').first();
    if (hint) await expect(kbd).toBeVisible();
    else await expect(kbd).toBeHidden();

    // The button stays inside its panel's padding (the panel body's content box).
    const fits = await button.evaluate((el) => {
      const body = el.closest('section')!.querySelector(':scope > div:last-child')!;
      const r = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      const b = el.getBoundingClientRect();
      return {
        left: b.left >= r.left + parseFloat(style.paddingLeft) - 0.5,
        right: b.right <= r.right - parseFloat(style.paddingRight) + 0.5,
      };
    });
    expect(fits).toEqual({ left: true, right: true });
  });
}
