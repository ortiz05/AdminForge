import { expect, test } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { PROBES } from '../support/web/fixtures/renderer';
import { routeContentBackend } from './support/content-backend';
import { mockApi, setPrefs } from './support/mock-api';

/**
 * Regression: opening a sign-in event froze the browser. The sign-in page's header title is an expression evaluated
 * asynchronously; the header reported it to the inspector (a state change there), the inspector rebuilt the page's
 * params as a new object on every render, so the page got a new data scope, evaluated the title again — "no title"
 * while pending, the name once done — and reported it again: the drawer title flipped hundreds of times a second,
 * without a single URL change or request. Now the inspector page only sees new params when the URL changes, and the
 * header reports a title once it has one.
 */
test('a sign-in event opens in the inspector and the drawer settles', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page, {});
  await routeContentBackend(page, {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, { theme: 'steel', density: 'comfortable' });
  await page.goto('/p/identity.sign-ins');
  const row = page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1);
  await expect(row).toBeVisible();
  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Avery Engineer → Azure Portal' });
  await expect(drawer.getByRole('tabpanel')).toBeVisible();
  await expect(page).toHaveURL(/inspect=page%3Aidentity\.sign-in/);

  // Settled: nothing in the page keeps changing (the loop changed it hundreds of times a second).
  const changes = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const o = new MutationObserver((m) => (n += m.length));
        o.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        setTimeout(() => {
          o.disconnect();
          resolve(n);
        }, 2_000);
      }),
  );
  expect(changes).toBeLessThan(10);
  await expect(drawer.getByRole('heading', { name: 'Avery Engineer → Azure Portal' })).toBeVisible();
});
