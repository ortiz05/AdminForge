import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { schedules } from '../support/web/fixtures/automation';
import { FIXED_NOW } from '../support/web/fixtures/session';
import { mockApi, setPrefs } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

// The Schedules page's "failed on the last run" alert with many failures (an automation identity without Azure
// access fails every Azure report): the five most recent named, the rest behind "Show n more".
const base = schedules().items;
const failed = base.find((s) => s.lastStatus === 'failed')!;
const extra = [
  'Weekly Azure Advisor recommendations report',
  'Weekly App Service security settings report',
  'Weekly Azure Arc agent and extension health report',
  'Daily disconnected Azure Arc machines report',
  'Weekly Azure Policy compliance report',
  'Weekly custom Azure roles with broad permissions report',
  'Weekly Key Vault configuration report',
].map((title, i) => ({
  ...failed,
  key: `reports.failing-${i + 1}`,
  title,
  lastRunAt: new Date(Date.parse(failed.lastRunAt!) + (8 - i) * 3_600_000).toISOString(),
}));

for (const theme of ['steel', 'daylight'] as const) {
  test(`visual · schedules · many failed · ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await setPrefs(page, { theme });
    const auto = automationApi();
    await mockApi(page, {
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === '/api/schedules'
            ? { body: { items: [...base, ...extra] } }
            : undefined,
        auto.handler,
      ],
    });
    await page.goto('/schedules');
    const alert = page.getByRole('alert').filter({ hasText: 'failed on the last run' });
    await expect(alert).toContainText('8 schedules failed on the last run');
    await expect(alert.getByRole('link')).toHaveCount(5);
    await expect(alert).toHaveScreenshot(`schedules-failed-folded-${theme}.png`);
    await alert.getByRole('button', { name: 'Show 3 more' }).click();
    await expect(alert.getByRole('link')).toHaveCount(8);
    await page.mouse.move(0, 0); // the links moved under the pointer: no hover underline in the image
    await expect(alert).toHaveScreenshot(`schedules-failed-open-${theme}.png`);
    const axe = await new AxeBuilder({ page }).include('[role="alert"]').analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });
}
