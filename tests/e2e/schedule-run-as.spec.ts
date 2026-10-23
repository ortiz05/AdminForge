import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { schedules } from '../support/web/fixtures/automation';
import { FIXED_NOW, me } from '../support/web/fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

// The schedule page's "Run as" control (docs/plans/2026-10-23-run-as-and-vault.md): where the account comes from and
// the Operator's choice of identity, in both themes.
const base = schedules().items.find((s) => s.key === 'reports.app-credential-expiry')!;
const item = {
  ...base,
  source: 'content',
  runsAs: { kind: 'app', name: 'reports-team', label: 'app identity reports-team', source: 'default' },
};

for (const theme of ['steel', 'daylight'] as const) {
  test(`visual · schedule · run as · ${theme}`, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await setPrefs(page, { theme });
    const auto = automationApi();
    await mockApi(page, {
      me: me({ roles: ['Portal.Reader', 'Portal.Operator'] }),
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === '/api/schedules' ? { body: { items: [item] } } : undefined,
        ({ method, path }) =>
          method === 'GET' && path === '/api/schedules/identities'
            ? { body: { apps: ['reports-team', 'ops-team'], user: false } }
            : undefined,
        auto.handler,
      ],
    });
    await page.goto('/schedules/reports.app-credential-expiry');
    await expect(page.getByRole('combobox', { name: 'Run as' })).toBeVisible();
    await expect(page.getByText('The installation’s default for this kind of schedule.')).toBeVisible();
    await settle(page);
    await growViewportToPage(page);
    await expect(page).toHaveScreenshot(`schedule-run-as-${theme}.png`);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
  });
}
