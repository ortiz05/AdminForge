import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, me } from './fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { automationApi, type AutomationOptions } from './support/mock-automation';

/**
 * Emergency stop (Admin → Settings): an admin pauses changes with a reason, everyone signed in sees the banner, and an
 * admin resumes. Pausing sends the CSRF header; a reader sees the banner but no way to change it.
 */

const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });
const READER = me({ roles: ['Portal.Reader'] });

async function open(
  page: Page,
  path: string,
  session = ADMIN,
  opts: AutomationOptions = {},
  theme = 'steel',
) {
  const auto = automationApi(opts);
  await mockApi(page, { me: session, handlers: [auto.handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(path);
  return auto;
}

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test('an admin pauses changes with a reason, sees the banner, and resumes', async ({ page }) => {
  const auto = await open(page, '/settings');
  const card = page.getByRole('region', { name: 'Pause changes or automation' });
  await expect(card).toBeVisible();
  const pause = card.getByRole('button', { name: 'Pause changes' });
  // No reason, no pause.
  await expect(pause).toBeDisabled();

  await card.getByRole('textbox', { name: 'Reason' }).first().fill('Suspected compromised operator account');
  await pause.click();
  // The banner, not the toast's live region (which repeats the text for screen readers).
  const banner = page
    .getByRole('status')
    .filter({ hasText: 'Changes are paused', hasNotText: 'Notifications' });
  await expect(banner).toBeVisible();
  expect(auto.state.emergencyPuts).toEqual([
    {
      body: { target: 'writes', paused: true, reason: 'Suspected compromised operator account' },
      csrf: true,
    },
  ]);
  await noAxeViolations(page);

  await card.getByRole('button', { name: 'Resume changes' }).click();
  await expect(banner).toHaveCount(0);
  expect(auto.state.emergencyPuts.at(-1)).toMatchObject({
    body: { target: 'writes', paused: false },
    csrf: true,
  });
});

test('a reader sees that changes are paused and why, with no way to change it', async ({ page }) => {
  await open(page, '/', READER, {
    emergency: { canPause: false, canResume: false, writesPausedBy: 'avery.admin@example.com' },
  });
  const banner = page.getByRole('status').filter({ hasText: 'Changes are paused' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Suspected compromised operator account');
  await expect(banner.getByRole('link', { name: 'Emergency stop settings' })).toHaveCount(0);
  await noAxeViolations(page);
});

for (const theme of ['steel', 'daylight'] as const)
  test(`banner while changes are paused · ${theme}`, async ({ page }) => {
    await open(
      page,
      '/',
      ADMIN,
      { emergency: { canPause: true, canResume: true, writesPausedBy: 'avery.admin@example.com' } },
      theme,
    );
    await expect(page.getByRole('status').filter({ hasText: 'Changes are paused' })).toBeVisible();
    await settle(page);
    await growViewportToPage(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`emergency-banner-${theme}.png`);
  });
