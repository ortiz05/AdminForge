import { expect, test, type Page } from '@playwright/test';
import { playbookHref } from '../../portal/apps/web/src/playbooks/url';
import { IDS } from '../support/web/fixtures/automation';
import { FIXED_NOW, armedMe, me } from '../support/web/fixtures/session';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { automationApi } from '../support/web/mock-automation';

/** Visual baselines for the automation and admin screens, in Steel (dark) and Daylight (light). */

const THEMES = ['steel', 'daylight'] as const;
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

async function open(page: Page, theme: string, path: string, session = ADMIN) {
  const auto = automationApi();
  await mockApi(page, { me: session, handlers: [auto.handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(path);
  return auto;
}

async function shoot(page: Page, name: string, { full = true } = {}) {
  await settle(page);
  if (full) await growViewportToPage(page);
  await settle(page);
  await expect(page).toHaveScreenshot(name);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

for (const theme of THEMES) {
  test(`playbook drawer · write · preview · ${theme}`, async ({ page }) => {
    await open(
      page,
      theme,
      playbookHref(
        {
          playbook: 'identity.disable-user',
          inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
        },
        '/runs',
      ),
      me(),
    );
    const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
    await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
    await expect(drawer.getByRole('region', { name: 'What this run will change' })).toBeVisible();
    await expect(drawer.getByText('Adele Lee')).toBeVisible();
    await shoot(page, `playbook-drawer-preview-${theme}.png`, { full: false });
  });

  test(`playbook drawer · read · outputs · ${theme}`, async ({ page }) => {
    await open(
      page,
      theme,
      playbookHref({ playbook: 'diagnostics.user-sign-in-check', inputs: { userId: IDS.mChen } }, '/runs'),
      me(),
    );
    const drawer = page.getByRole('dialog', { name: 'Check a user’s sign-ins' });
    await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
    await expect(drawer.getByRole('region', { name: 'Outputs' })).toBeVisible();
    await drawer.getByRole('region', { name: 'Preview' }).scrollIntoViewIfNeeded();
    await shoot(page, `playbook-drawer-read-${theme}.png`, { full: false });
  });

  test(`run page · live run finished · ${theme}`, async ({ page }) => {
    await open(page, theme, `/runs/${IDS.liveRun}`);
    await expect(page.locator('header').getByText('Succeeded')).toBeVisible();
    await expect(page.getByRole('log', { name: 'Run logs' })).toContainText('Graph throttled once');
    await shoot(page, `run-succeeded-${theme}.png`);
  });

  test(`run page · show-once secret · ${theme}`, async ({ page }) => {
    await open(page, theme, `/runs/${IDS.tapRun}`);
    const panel = page.getByRole('region', { name: 'Copy now — it won’t be shown again' });
    await expect(panel).toBeVisible();
    await shoot(page, `run-secret-${theme}.png`);
  });

  test(`run page · failed with hint · ${theme}`, async ({ page }) => {
    await open(page, theme, `/runs/${IDS.failedRun}`);
    await expect(page.getByText('The run failed')).toBeVisible();
    await shoot(page, `run-failed-${theme}.png`);
  });

  test(`runs list · ${theme}`, async ({ page }) => {
    await open(page, theme, '/runs');
    await expect(page.getByRole('grid', { name: 'Runs' }).getByText('Rolled back')).toBeVisible();
    await shoot(page, `runs-${theme}.png`);
  });

  test(`approvals · ${theme}`, async ({ page }) => {
    await open(page, theme, '/approvals');
    await expect(page.getByRole('article', { name: 'Approval: Disable sign-in' })).toBeVisible();
    await shoot(page, `approvals-${theme}.png`);
  });

  test(`runbook · in progress · ${theme}`, async ({ page }) => {
    await open(page, theme, `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`);
    await expect(page.getByRole('button', { name: 'Mark done' })).toBeVisible();
    await shoot(page, `runbook-${theme}.png`);
  });

  test(`schedules · ${theme}`, async ({ page }) => {
    await open(page, theme, '/schedules');
    await expect(
      page.getByRole('grid', { name: 'Schedules' }).getByText('Every Monday at 07:00', { exact: true }),
    ).toBeVisible();
    await shoot(page, `schedules-${theme}.png`);
  });

  test(`schedule detail · ${theme}`, async ({ page }) => {
    await open(page, theme, '/schedules/reports.app-credential-expiry');
    await expect(page.getByRole('table', { name: /Runs of/ })).toBeVisible();
    await shoot(page, `schedule-detail-${theme}.png`);
  });

  test(`monitoring · ${theme}`, async ({ page }) => {
    await open(page, theme, '/monitoring');
    await expect(page.getByRole('button', { name: /Microsoft Graph reachability/ })).toBeVisible();
    await shoot(page, `monitoring-${theme}.png`);
  });

  test(`monitoring detail · ${theme}`, async ({ page }) => {
    await open(page, theme, '/monitoring?probe=probes.token-exchange');
    await expect(
      page.getByRole('dialog', { name: 'Token: Exchange Online' }).locator('figure svg').first(),
    ).toBeVisible();
    await shoot(page, `monitoring-detail-${theme}.png`, { full: false });
  });

  test(`audit · ${theme}`, async ({ page }) => {
    await open(page, theme, '/audit');
    await expect(page.getByText('Chain verified ✓ · 12,408 events')).toBeVisible();
    await shoot(page, `audit-${theme}.png`);
  });

  test(`appearance · contrast rejected · ${theme}`, async ({ page }) => {
    await open(page, theme, '/appearance');
    await page.getByRole('textbox', { name: 'Daylight accent hex value' }).fill('#9AB8E8');
    await expect(page.getByText('This can’t be published: some text would be hard to read')).toBeVisible();
    await shoot(page, `appearance-${theme}.png`);
  });

  test(`settings · ${theme}`, async ({ page }) => {
    await open(page, theme, '/settings');
    await expect(page.getByText('Mock sign-in is on')).toBeVisible();
    await shoot(page, `settings-${theme}.png`);
  });
}

test('playbook drawer · armed · bulk · steel', async ({ page }) => {
  const items = [
    { userId: IDS.aLee, $label: 'Adele Lee' },
    { userId: IDS.mChen, $label: 'Ming Chen' },
    { userId: IDS.jDoe, $label: 'Jordan Doe' },
  ];
  await open(
    page,
    'steel',
    playbookHref(
      { playbook: 'identity.revoke-sessions', items, inputs: { reason: 'Quarterly leaver sweep' } },
      '/runs',
    ),
    armedMe(),
  );
  await expect(
    page.getByRole('dialog', { name: 'Revoke sessions' }).getByRole('table', { name: 'Inputs per item' }),
  ).toBeVisible();
  await expect(page.getByText(/Armed · 47:12/)).toBeVisible();
  await shoot(page, 'playbook-drawer-bulk-armed-steel.png', { full: false });
});

test('playbook drawer · armed · typed confirmation · steel', async ({ page }) => {
  await open(
    page,
    'steel',
    playbookHref(
      {
        playbook: 'identity.disable-user',
        inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      },
      '/runs',
    ),
    armedMe(),
  );
  const drawer = page.getByRole('dialog', { name: 'Disable sign-in' });
  await drawer.getByRole('button', { name: 'Preview (dry run)' }).click();
  await expect(drawer.getByRole('region', { name: 'What this run will change' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Disable sign-in', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Disable sign-in?' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Disable sign-in?' })
    .getByLabel(/to confirm/)
    .fill('a.lee@exam');
  await shoot(page, 'playbook-confirm-armed-steel.png', { full: false });
});
