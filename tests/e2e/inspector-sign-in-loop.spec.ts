import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { PROBES } from '../support/web/fixtures/renderer';
import { routeContentBackend, type BackendOptions } from './support/content-backend';
import { mockApi, setPrefs, settle } from './support/mock-api';

/**
 * Regression: the inspector "refreshing loop". A read that keeps answering 401 `reauth` sent the browser to sign in;
 * single sign-on came straight back to the same deep link and the read failed again — the tab reloaded about once a
 * second, forever. Silent SSO is simulated by answering /auth/login with a redirect to its returnTo. Now: at most one
 * automatic round trip, then the screen says what happened and offers "Sign in again" once.
 */
const REAUTH = {
  error: {
    code: 'reauth',
    message: 'Microsoft needs you to sign in again.',
    hint: 'Sign in again to continue. If this keeps coming back, give a portal administrator the reference.',
    login: '/auth/login?returnTo=%2F',
    reauth: { url: '/auth/login?returnTo=%2F' },
    correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
  },
};

async function setup(page: Page, override?: BackendOptions['override']) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page, {});
  await routeContentBackend(page, override ? { override } : {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  const counter = { signIns: 0 };
  await page.route('**/auth/login**', (route) => {
    counter.signIns++;
    const returnTo = new URL(route.request().url()).searchParams.get('returnTo') ?? '/';
    return route.fulfill({ status: 302, headers: { location: returnTo } });
  });
  await setPrefs(page, { theme: 'steel', density: 'comfortable' });
  return counter;
}

test('a lookup that keeps asking for sign-in does not send the inspector round in circles', async ({
  page,
}) => {
  const counter = await setup(page);
  await page.route('**/api/me/capabilities', (route) => route.fulfill({ status: 401, json: REAUTH }));
  await page.goto('/p/identity.users');
  const row = page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1);
  const name = (await row.getByRole('gridcell').nth(1).locator('span span').first().textContent())!.trim();
  let loads = 0;
  page.on('load', () => loads++);
  await row.click();
  const drawer = page.getByRole('dialog', { name });
  await expect(drawer.getByRole('tabpanel')).toBeVisible();
  // Long enough for several rounds of the old loop (one every second or so).
  await page.waitForTimeout(5_000);
  expect(counter.signIns).toBe(0);
  expect(loads).toBe(0);
  await expect(page).toHaveURL(/inspect=page%3Aidentity\.user/);
});

test('the inspector’s data needs a fresh sign-in: one round trip, then one banner — not an error per widget', async ({
  page,
}) => {
  const counter = await setup(page, async (route, url) => {
    if (url.pathname !== '/api/datasources/execute-many') return false;
    const body = JSON.parse(route.request().postData() ?? '{}') as { page?: string };
    if (body.page !== 'identity.user') return false;
    await route.fulfill({ status: 401, json: REAUTH });
    return true;
  });
  await page.goto('/p/identity.users');
  await page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1).click();
  const drawer = page.getByRole('dialog').first();
  const banner = drawer.getByRole('region', { name: 'Sign in again' });
  await expect(banner).toBeVisible();
  await settle(page);
  expect(counter.signIns).toBe(1);
  await expect(banner.getByText('Microsoft needs you to sign in again')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Sign in again' })).toHaveCount(1);
  await expect(drawer.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(drawer.getByText(/^Sign in again to see /).first()).toBeVisible();
  // A failed read is not "Sign-in blocked": no status pill while the header's data is missing.
  await expect(drawer.getByText('Sign-in blocked')).toHaveCount(0);
  await expect(drawer.getByText('Sign-in allowed')).toHaveCount(0);
  await expect(page).toHaveScreenshot('inspector-sign-in-banner-steel.png');
});

test('the session itself keeps asking for sign-in: one round trip, then "Sign-in didn’t finish"', async ({
  page,
}) => {
  const counter = await setup(page);
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, json: REAUTH }));
  await page.goto('/p/identity.users?inspect=page%3Aidentity.user&i.id=00000000-0000-4000-8000-0000000000a1');
  await expect(page.getByRole('alert').getByText('Sign-in didn’t finish')).toBeVisible();
  await expect(
    page.getByText('If this screen comes back, give a portal administrator the reference.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(counter.signIns).toBe(1);
});
