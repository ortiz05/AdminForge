import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { mockApi, setPrefs } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/**
 * Synthetic monitoring by service: tiles grouped by the service each probe watches (Exchange Online, SharePoint
 * Online, Teams, …), one service on its own through `?group=` (each service section's "Service checks" link), and the
 * by-check view.
 */

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  return results.violations.map((v) => v.id);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await setPrefs(page, { theme: 'steel' });
});

test('groups probes by service, worst first', async ({ page }) => {
  await mockApi(page, { handlers: [automationApi().handler] });
  await page.goto('/monitoring');
  const main = page.getByRole('main');
  for (const name of ['Exchange Online', 'SharePoint Online', 'Teams', 'AdminForge'])
    await expect(main.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) })).toBeVisible();
  const exchange = main.getByRole('region', { name: /^Exchange Online/ });
  await expect(
    exchange.getByRole('button', { name: /Mail flow — end-to-end delivery: Healthy/ }),
  ).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('one service through ?group=, grouped by check, and back to every service', async ({ page }) => {
  await mockApi(page, { handlers: [automationApi().handler] });
  await page.goto('/monitoring?group=sharepoint');
  await expect(page.getByRole('heading', { level: 1, name: 'Service checks' })).toBeVisible();
  await expect(page).toHaveTitle(/Service checks · SharePoint Online/);
  const main = page.getByRole('main');
  await expect(
    main.getByRole('button', { name: /SharePoint files — upload, download, delete: Degraded/ }),
  ).toBeVisible();
  await expect(main.getByRole('button', { name: /Microsoft Graph reachability/ })).toHaveCount(0);
  // One service is grouped by check; the by-service switch isn't offered.
  await expect(main.getByRole('heading', { level: 2, name: /^File round trip/ })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Group probes by' })).toHaveCount(0);
  // The KPI strip counts this service only.
  await expect(main.getByText('of 2 probes')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('link', { name: 'All services' }).click();
  await expect(page).not.toHaveURL(/group=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Synthetic monitoring' })).toBeVisible();
  await expect(main.getByRole('button', { name: /Microsoft Graph reachability/ })).toBeVisible();
});

test('a service without probes yet says how to add one', async ({ page }) => {
  await mockApi(page, { handlers: [automationApi().handler] });
  await page.goto('/monitoring?group=endpoint');
  await expect(page.getByText('No checks for Endpoint yet')).toBeVisible();
  await expect(page.getByText('pnpm adminforge new probe endpoint/<name>')).toBeVisible();
});

test('by check: one group per kind of check, each tile naming its service', async ({ page }) => {
  await mockApi(page, { handlers: [automationApi().handler] });
  await page.goto('/monitoring');
  await page.getByRole('radio', { name: 'By check' }).click();
  await expect(page).toHaveURL(/by=check/);
  const main = page.getByRole('main');
  for (const name of ['Mail flow', 'File round trip', 'Teams meetings', 'HTTP endpoints'])
    await expect(main.getByRole('heading', { level: 2, name: new RegExp(`^${name}`) })).toBeVisible();
  const meetings = main.getByRole('region', { name: /^Teams meetings/ });
  await expect(meetings.getByText('Teams', { exact: true })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
