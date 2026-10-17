import { expect, test } from '@playwright/test';
import { FIXED_NOW } from '../../support/web/fixtures/session';
import { PROBES } from '../../support/web/fixtures/renderer';
import { routeContentBackend } from '../support/content-backend';
import { mockApi, setPrefs } from '../support/mock-api';

// The production build under the API's script policy (`script-src 'self'`, no eval): nothing in the bundle may try
// eval. Zod 4 probes `Function('')` to decide whether to compile validators; the web app turns that off first
// (lib/no-eval.ts), or every page load logs a CSP violation in the browser console.

test('no Content-Security-Policy violations in the production build', async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  // The documents get the API's script policy (vite preview sends none).
  await page.route(
    (url) => url.pathname.startsWith('/p/'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'content-security-policy': "script-src 'self'" },
      });
    },
  );
  await mockApi(page);
  await routeContentBackend(page, {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, { theme: 'steel' });
  // A page with params, filters and widgets: schemas validate its definition and its params.
  await page.goto('/p/azure.resources');
  // The content backend starts cold in each worker (as in charts.spec.ts).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);

  // Control: the policy is in force and the listener sees what it blocks — an inline script (page.evaluate itself may
  // eval: DevTools evaluations bypass the policy).
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.head.append(s);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))
    .toEqual([expect.stringMatching(/^script-src(-elem)? inline/)]);
  expect(
    await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan),
  ).toBeUndefined();
});
