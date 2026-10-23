import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/**
 * Monitoring's states beyond the full page (design review, 2026-10-23): a phone-width window (the timeline's labels
 * above their rows, the key figures two to a row) and a failed load — figures that couldn't be shown say so, never a
 * green zero.
 */

const FAIL = {
  status: 500,
  body: {
    error: {
      code: 'internal',
      message: 'The portal could not read this.',
      hint: 'Try again.',
      correlationId: '11111111-2222-4333-8444-555555555555',
    },
  },
};

async function open(page: Page, path: string, fail?: 'probes' | 'schedules') {
  const failing = fail
    ? [
        ({ method, path: p }: { method: string; path: string }) =>
          method === 'GET' && p === `/api/${fail}` ? FAIL : undefined,
      ]
    : [];
  await mockApi(page, { handlers: [...failing, automationApi().handler] });
  await setPrefs(page, { theme: 'steel', density: 'comfortable' });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test('monitoring · phone width · steel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, '/monitoring');
  await expect(page.getByRole('list', { name: 'Worst result per hour' })).toBeVisible();
  await settle(page);
  await growViewportToPage(page, 390);
  await settle(page);
  await expect(page).toHaveScreenshot('monitoring-phone-steel.png');
});

test('monitoring · checks didn’t load · steel', async ({ page }) => {
  await open(page, '/monitoring', 'probes');
  await expect(page.getByText('Checks didn’t load')).toBeVisible();
  const figures = page.getByRole('region', { name: 'Health' });
  await expect(figures.getByText('didn’t load — see below').first()).toBeVisible();
  await expect(figures.getByText('of 0 checks')).toHaveCount(0);
  await settle(page);
  await expect(page).toHaveScreenshot('monitoring-checks-failed-steel.png');
});
