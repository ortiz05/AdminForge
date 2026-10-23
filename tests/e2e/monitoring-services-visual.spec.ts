import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/** Visual baselines for Monitoring's per-service and by-check views, in Steel (dark) and Daylight (light). */

const THEMES = ['steel', 'daylight'] as const;

async function open(page: Page, theme: string, path: string) {
  await mockApi(page, { handlers: [automationApi().handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(path);
}

async function shoot(page: Page, name: string) {
  await settle(page);
  await growViewportToPage(page);
  await settle(page);
  await expect(page).toHaveScreenshot(name);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

for (const theme of THEMES) {
  test(`monitoring · one service · ${theme}`, async ({ page }) => {
    await open(page, theme, '/monitoring?group=exchange');
    await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
    await shoot(page, `monitoring-service-${theme}.png`);
  });

  test(`monitoring · by check · ${theme}`, async ({ page }) => {
    await open(page, theme, '/monitoring?by=check');
    await expect(page.getByRole('heading', { level: 3, name: /^Mail flow/ })).toBeVisible();
    await shoot(page, `monitoring-by-check-${theme}.png`);
  });
}
