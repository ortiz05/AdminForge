import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, armedMe } from './fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';

const THEMES = ['steel', 'daylight', 'contrast'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id}: ${v.help} (${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(', ')})`,
  );
  expect(summary).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

for (const theme of THEMES) {
  for (const density of DENSITIES) {
    test(`overview · ${theme} · ${density}`, async ({ page }) => {
      await mockApi(page);
      await setPrefs(page, { theme, density });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Example Org' })).toBeVisible();
      await expect(page.getByRole('grid', { name: 'Licence subscriptions' }).getByRole('row')).toHaveCount(8);
      await settle(page);
      await growViewportToPage(page);
      await expect(page).toHaveScreenshot(`overview-${theme}-${density}.png`);
      await expectNoAxeViolations(page);
    });

    test(`design · ${theme} · ${density}`, async ({ page }) => {
      await mockApi(page);
      await setPrefs(page, { theme, density });
      await page.goto('/design');
      await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
      await expect(page.locator('figure svg').first()).toBeVisible();
      await settle(page);
      await growViewportToPage(page);
      await settle(page);
      await expect(page).toHaveScreenshot(`design-${theme}-${density}.png`);
      await expectNoAxeViolations(page);
    });
  }
}

for (const theme of THEMES) {
  test(`armed shell · ${theme}`, async ({ page }) => {
    await mockApi(page, { me: armedMe() });
    await setPrefs(page, { theme, density: 'comfortable' });
    await page.goto('/');
    await expect(page.getByText(/Armed · 47:12/)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'armed');
    await settle(page);
    await expect(page).toHaveScreenshot(`shell-armed-${theme}.png`);
    await expectNoAxeViolations(page);
  });
}

test('collapsed navigation · steel', async ({ page }) => {
  await mockApi(page);
  await setPrefs(page, { theme: 'steel', navCollapsed: true });
  await page.goto('/identity/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('coming-soon-collapsed-steel.png');
  await expectNoAxeViolations(page);
});

test('overview error state · steel', async ({ page }) => {
  await mockApi(page, { overviewStatus: 503 });
  await setPrefs(page, { theme: 'steel' });
  await page.goto('/');
  await expect(page.getByText('The tenant overview didn’t load')).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('overview-error-steel.png');
});

test('arm dialog and command palette · steel', async ({ page }) => {
  await mockApi(page);
  await setPrefs(page, { theme: 'steel' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Example Org' })).toBeVisible();
  await page.getByRole('button', { name: 'Arm write access' }).click();
  await expect(page.getByRole('dialog', { name: 'Arm write access' })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('arm-dialog-steel.png');
  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.type('theme');
  await expect(page).toHaveScreenshot('command-palette-steel.png');
});
