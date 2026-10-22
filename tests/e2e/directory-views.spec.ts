import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { PROBES } from '../support/web/fixtures/renderer';
import { routeContentBackend } from './support/content-backend';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';

// The Groups and Users pages' built-in views (docs/plans/2026-10-22-group-and-user-views.md), picked from the Views
// menu against the real BFF pipeline and synthetic fixtures: a member view switches the Groups page to the member
// table (direct-member counts, its note), an inactivity view the Users page to the sign-in table.
const THEMES = ['steel', 'daylight'] as const;

async function open(page: Page, path: string, theme = 'steel') {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockApi(page);
  await routeContentBackend(page, {});
  await page.route('**/api/probes', (route) => route.fulfill({ json: PROBES }));
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(path);
}

async function pickView(page: Page, name: string) {
  await page.getByRole('button', { name: /Saved views/ }).click();
  await page.getByRole('menuitem', { name }).click();
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const grid = (page: Page) => page.getByRole('grid', { name: 'Results' });

test.describe('identity.groups views', () => {
  test('Fewer than 5 members switches to the member table, with the count and its note', async ({ page }) => {
    await open(page, '/p/identity.groups');
    await expect(grid(page).getByRole('row').nth(2)).toBeVisible();
    await pickView(page, 'Fewer than 5 members');
    await expect(page).toHaveURL(/members=UnderFive/);
    await expect(page.getByRole('columnheader', { name: /Direct members/ })).toBeVisible();
    await expect(page.getByText(/a nested group counts as one member/)).toBeVisible();
    // The fixture's groups under 5 members, and not the one with 7.
    await expect(grid(page).getByText('SG-Example-Approvers')).toBeVisible();
    await expect(grid(page).getByText('Example Project Falcon')).toHaveCount(0);
  });

  test('No owners stays on the Graph list', async ({ page }) => {
    await open(page, '/p/identity.groups');
    await pickView(page, 'No owners');
    await expect(page).toHaveURL(/owners=None/);
    await expect(page.getByRole('columnheader', { name: /Direct members/ })).toHaveCount(0);
    await expect(grid(page).getByRole('row').nth(1)).toBeVisible();
  });

  for (const theme of THEMES) {
    test(`visual · groups · fewer than 5 members · ${theme}`, async ({ page }) => {
      await open(page, '/p/identity.groups?members=UnderFive', theme);
      await expect(grid(page).getByText('SG-Example-Approvers')).toBeVisible();
      await settle(page);
      await growViewportToPage(page);
      await expect(page).toHaveScreenshot(`directory-views-groups-members-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe('identity.users views', () => {
  test('No sign-in for a year switches to the sign-in table, with its note', async ({ page }) => {
    await open(page, '/p/identity.users');
    await pickView(page, 'No sign-in for a year');
    await expect(page).toHaveURL(/activity=Inactive365/);
    await expect(page.getByText(/Last successful sign-in over a year ago/)).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Last sign-in/ })).toBeVisible();
    await expect(grid(page).getByRole('row').nth(1)).toBeVisible();
  });

  for (const theme of THEMES) {
    test(`visual · users · inactive a year · ${theme}`, async ({ page }) => {
      await open(page, '/p/identity.users?activity=Inactive365', theme);
      await expect(grid(page).getByRole('row').nth(1)).toBeVisible();
      await settle(page);
      await growViewportToPage(page);
      await expect(page).toHaveScreenshot(`directory-views-users-inactive-${theme}.png`);
      await expectNoAxeViolations(page);
    });
  }
});
