import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PORTAL_SCHEDULE_KEY, REPORTS } from './fixtures/reports';
import { FIXED_NOW, me } from './fixtures/session';
import { backendUrl, routeContentBackend } from './support/content-backend';
import { growViewportToPage, mockApi, setPrefs, settle } from './support/mock-api';
import { reportsApi, type ReportsMockOptions } from './support/mock-reports';

// The report catalogue (/reports) in mock mode: every /api call is answered by support/mock-reports.ts (synthetic
// reports and schedules), so only the Vite dev server runs. Filters in the URL, the details panel, scheduling a report
// (the POST body), editing and deleting a portal schedule, what a Reader sees, a refused cadence, screenshots in steel
// and daylight (and a phone), and axe.

const OPERATOR = me();
const READER = me({ roles: ['Portal.Reader'] });

async function open(
  page: Page,
  path: string,
  {
    session = OPERATOR,
    theme = 'steel',
    mock = {},
  }: { session?: typeof OPERATOR; theme?: string; mock?: ReportsMockOptions } = {},
) {
  const reports = reportsApi(mock);
  const { calls } = await mockApi(page, { me: session, handlers: [reports.handler] });
  await setPrefs(page, { theme, density: 'comfortable' });
  await page.goto(path);
  return { ...reports, calls };
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(', ')})`,
    ),
  ).toEqual([]);
}

const grid = (page: Page) => page.getByRole('grid', { name: 'Reports' });
/** Data rows (the header is row 1). */
const rows = (page: Page) =>
  grid(page)
    .getByRole('row')
    .filter({ hasNot: page.getByRole('columnheader') });
const details = (page: Page, title: string | RegExp) => page.getByRole('dialog', { name: title });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test('filters by area, tag, search and schedule state in the URL; details open beside the list and Back closes them', async ({
  page,
}) => {
  await open(page, '/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await expect(rows(page)).toHaveCount(REPORTS.length);
  const kpis = page.getByRole('region', { name: 'Report summary' });
  await expect(kpis.getByRole('group', { name: 'Reports' })).toContainText('10');
  await expect(kpis.getByRole('group', { name: 'Scheduled' })).toContainText('3');
  await expect(kpis.getByRole('group', { name: 'Failing schedules' })).toContainText('1');
  await expect(kpis.getByRole('group', { name: 'Need a licence' })).toContainText('3');
  // The rail lists the catalogue, not each report.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'All reports' })).toHaveAttribute('aria-current', 'page');

  const filters = page.getByRole('search', { name: 'Filter reports' });
  await filters.getByRole('button', { name: 'Area', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Filter by area' })
    .getByRole('checkbox', { name: 'Identity' })
    .click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/[?&]area=identity/);
  await expect(rows(page)).toHaveCount(4);

  // A tag chip in a row adds that tag; tags combine with "and".
  await rows(page)
    .filter({ hasText: 'Inactive guests' })
    .getByRole('button', { name: 'Show reports tagged hygiene' })
    .click();
  await expect(page).toHaveURL(/[?&]tag=hygiene/);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove filter Area: Identity' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByText('4 of 10 reports')).toBeVisible();

  await filters.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page).not.toHaveURL(/tag=/);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('secure score');
  await expect(page).toHaveURL(/[?&]q=secure/);
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('');
  await page.getByRole('radio', { name: 'Scheduled', exact: true }).click();
  await expect(page).toHaveURL(/[?&]scheduled=yes/);
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('no such report');
  await expect(page.getByText('No reports match these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(REPORTS.length);

  // Details: what it needs, its schedules (content and portal) with the latest file, and the export columns.
  await grid(page).getByRole('link', { name: 'Inactive users', exact: true }).click();
  await expect(page).toHaveURL(/[?&]report=identity\.inactive-users/);
  const panel = details(page, 'Inactive users');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Requires Entra P1');
  const schedules = panel.getByRole('list', { name: 'Schedules of Inactive users' });
  await expect(schedules.getByRole('listitem')).toHaveCount(2);
  await expect(schedules).toContainText('Created by mock.engineer@example.com');
  await expect(schedules).toContainText('Content');
  await expect(
    schedules.getByRole('link', { name: /Download the latest file, inactive-users-2026-10-15\.xlsx/ }),
  ).toHaveAttribute('href', `/api/schedules/${PORTAL_SCHEDULE_KEY}/artifacts/sr-iu-2`);
  await expect(panel.getByRole('list', { name: 'Export columns' })).toContainText('Days inactive');
  await expect(panel.getByRole('link', { name: 'Open report' })).toHaveAttribute(
    'href',
    '/p/identity.inactive-users',
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/report=/);
  await expect(panel).toBeHidden();

  // A shared link opens the same view.
  await page.goto('/reports?report=identity.app-credential-expiry&tag=apps');
  await expect(details(page, 'App credential expiry')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await details(page, 'App credential expiry').getByRole('button', { name: 'Close' }).click();
  await expect(page).not.toHaveURL(/report=/);
  await expect(page).toHaveURL(/tag=apps/);
});

test('schedule a report: the form sends the cadence, changed params and delivery keys', async ({ page }) => {
  const api = await open(page, '/reports?report=identity.inactive-guests');
  const panel = details(page, 'Inactive guests');
  await expect(panel).toContainText('Not scheduled.');
  await panel.getByRole('button', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(/[?&]schedule=new/);
  const form = page.getByRole('dialog', { name: 'Schedule Inactive guests' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Inactive guests, weekly');
  await expect(form.getByText('Runs every Monday at 06:00 UTC')).toBeVisible();

  await form.getByRole('combobox', { name: 'Repeats' }).click();
  await page.getByRole('option', { name: 'Weekdays' }).click();
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Inactive guests, weekdays');
  await form.getByRole('combobox', { name: 'Inactive for at least' }).click();
  await page.getByRole('option', { name: '30 days' }).click();
  await form.getByRole('radio', { name: 'CSV' }).click();
  await form.getByRole('combobox', { name: 'Email the file to' }).click();
  await page.getByRole('option', { name: 'Report recipients' }).click();
  await form.getByRole('combobox', { name: 'Alert in Teams' }).click();
  await page.getByRole('option', { name: 'Teams alerts' }).click();
  await form.getByRole('button', { name: 'Create schedule' }).click();

  await expect(page.getByText('Schedule created', { exact: true })).toBeVisible();
  await expect(form).toBeHidden();
  await expect(page).not.toHaveURL(/schedule=new/);
  expect(api.state.posts).toEqual([
    {
      title: 'Inactive guests, weekdays',
      cron: '0 6 * * 1-5',
      timezone: 'UTC',
      job: {
        kind: 'report',
        ref: 'identity.inactive-guests',
        params: { days: 30 },
        format: 'csv',
        retain: 26,
        emailKey: 'AF_REPORT_RECIPIENTS',
      },
      notifyOnFailure: { teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' },
    },
  ]);
  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/schedules');
  expect(post?.csrf).toBe('e2e-csrf-token');
  const list = panel.getByRole('list', { name: 'Schedules of Inactive guests' });
  await expect(list.getByRole('link', { name: 'Inactive guests, weekdays' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Edit Inactive guests, weekdays' })).toBeVisible();
});

test('edit a portal schedule from its page, then delete it from the catalogue', async ({ page }) => {
  const api = await open(page, `/schedules/${PORTAL_SCHEDULE_KEY}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Inactive users, weekdays' })).toBeVisible();
  await expect(page.getByText('Created in the portal by mock.engineer@example.com')).toBeVisible();
  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/reports\\?.*report=identity\\.inactive-users.*edit=${PORTAL_SCHEDULE_KEY.replace(/\./g, '\\.')}`,
    ),
  );
  const form = page.getByRole('dialog', { name: 'Edit Inactive users, weekdays' });
  await expect(form.getByRole('combobox', { name: 'Repeats' })).toHaveText('Weekdays');
  await expect(form.getByLabel('At', { exact: true })).toHaveValue('06:30');
  await expect(form.getByRole('combobox', { name: 'Time zone' })).toHaveText('Europe/London');
  await expect(form.getByRole('combobox', { name: 'Inactive for at least' })).toHaveText('30 days');
  await expect(form.getByRole('combobox', { name: 'Email the file to' })).toHaveText('Report recipients');
  await expect(form.getByRole('combobox', { name: 'Alert in Teams' })).toHaveText('Teams alerts');
  await form.getByRole('textbox', { name: 'Name' }).fill('Inactive users for HR');
  await form.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Schedule saved', { exact: true })).toBeVisible();
  expect(api.state.puts).toEqual([
    {
      key: PORTAL_SCHEDULE_KEY,
      body: {
        title: 'Inactive users for HR',
        cron: '30 6 * * 1-5',
        timezone: 'Europe/London',
        job: {
          kind: 'report',
          ref: 'identity.inactive-users',
          params: { days: 30 },
          format: 'xlsx',
          retain: 26,
          emailKey: 'AF_REPORT_RECIPIENTS',
        },
        notifyOnFailure: { teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' },
      },
    },
  ]);

  const panel = details(page, 'Inactive users');
  const list = panel.getByRole('list', { name: 'Schedules of Inactive users' });
  await expect(list.getByRole('link', { name: 'Inactive users for HR' })).toBeVisible();
  // Content schedules can't be edited here; portal ones by their creator (or an admin) can.
  await expect(list.getByRole('button', { name: /^Edit / })).toHaveCount(1);
  await list.getByRole('button', { name: 'Delete Inactive users for HR' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete Inactive users for HR?' });
  await confirm.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(page.getByText('Schedule deleted', { exact: true })).toBeVisible();
  expect(api.state.deletes).toEqual([PORTAL_SCHEDULE_KEY]);
  await expect(list.getByRole('listitem')).toHaveCount(1);
});

test('a Reader sees no Schedule button; a report without an export says why it can’t be scheduled', async ({
  page,
}) => {
  await open(page, '/reports?report=identity.inactive-users', { session: READER });
  const panel = details(page, 'Inactive users');
  await expect(panel.getByText('Scheduling a report needs the Portal Operator role.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Schedule' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  // A form link doesn't open the form either.
  await page.goto('/reports?report=identity.inactive-users&schedule=new');
  await expect(details(page, 'Inactive users')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Schedule / })).toHaveCount(0);

  await open(page, '/reports?report=azure.budgets');
  const budgets = details(page, 'Azure budgets');
  const button = budgets.getByRole('button', { name: 'Schedule' });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAccessibleDescription('This report has no export, so it can’t be scheduled.');
});

test('a cadence the API refuses shows its message and what to do, and the form stays open', async ({
  page,
}) => {
  const api = await open(page, '/reports?report=identity.inactive-guests&schedule=new');
  const form = page.getByRole('dialog', { name: 'Schedule Inactive guests' });
  await form.getByRole('combobox', { name: 'Repeats' }).click();
  await page.getByRole('option', { name: 'Custom (cron)' }).click();
  await form.getByRole('textbox', { name: 'Cron expression' }).fill('*/30 * * * *');
  await expect(form.getByText(/Runs every 30 minutes/)).toBeVisible();
  await form.getByRole('button', { name: 'Create schedule' }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('Reports can run at most once an hour.');
  await expect(alert).toContainText('Choose Every hour or a slower cadence');
  await expect(alert).toContainText('Reference 7c1e4b2a-0d3f-4e5a-9b6c-8d7e6f5a4b3c');
  expect(api.state.posts).toHaveLength(1);
  await expect(form).toBeVisible();
});

test('without a mail sender the form explains email instead of offering it', async ({ page }) => {
  await open(page, '/reports?report=identity.inactive-guests&schedule=new', { mock: { noEmail: true } });
  const form = page.getByRole('dialog', { name: 'Schedule Inactive guests' });
  await expect(form.getByText(/Email isn’t set up on this installation/)).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Email the file to' })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Post to Teams' })).toBeVisible();
});

test('reads the real catalogue from the BFF (published content over synthetic fixtures)', async ({
  page,
}) => {
  // Contract check: GET /api/reports and /api/reports/:key from the real API pipeline (support/content-backend.ts).
  await mockApi(page);
  await routeContentBackend(page);
  const res = await fetch(`${await backendUrl()}/api/reports`);
  expect(res.status).toBe(200);
  const catalogue = (await res.json()) as { items: Array<{ key: string }> };
  expect(catalogue.items.length).toBeGreaterThan(40);
  await page.goto('/reports?report=identity.inactive-users');
  await expect(page.getByText(`${catalogue.items.length} reports`, { exact: true })).toBeVisible();
  await expect(rows(page)).not.toHaveCount(0);
  const panel = details(page, 'Inactive users');
  await expect(
    panel.getByRole('list', { name: 'Export columns' }).getByRole('listitem').first(),
  ).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open report' })).toHaveAttribute(
    'href',
    '/p/identity.inactive-users',
  );
  // The rail lists the catalogue, not every report.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'All reports' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Inactive users' })).toHaveCount(0);
});

for (const theme of ['steel', 'daylight'] as const) {
  test(`catalogue · ${theme}`, async ({ page }) => {
    await open(page, '/reports', { theme });
    await expect(rows(page)).toHaveCount(REPORTS.length);
    await settle(page);
    await growViewportToPage(page);
    await expect(page).toHaveScreenshot(`reports-${theme}.png`);
    await expectNoAxeViolations(page);
  });

  test(`details · ${theme}`, async ({ page }) => {
    await open(page, '/reports?report=identity.inactive-users', { theme });
    const panel = details(page, 'Inactive users');
    await expect(panel.getByRole('list', { name: 'Export columns' })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Download the latest file/ })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`reports-details-${theme}.png`);
    await expectNoAxeViolations(page);
  });

  test(`schedule form · ${theme}`, async ({ page }) => {
    await open(page, '/reports?report=endpoint.stale-devices&schedule=new', { theme });
    const form = page.getByRole('dialog', { name: 'Schedule Stale devices' });
    await expect(form.getByRole('combobox', { name: 'Email the file to' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`reports-schedule-form-${theme}.png`);
    await expectNoAxeViolations(page);
  });
}

test('catalogue · phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/reports');
  await expect(rows(page).first()).toBeVisible();
  // Nothing on the page may be wider than the window (the table scrolls inside its own box).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await settle(page);
  await growViewportToPage(page, 390);
  await expect(page).toHaveScreenshot('reports-phone-steel.png');
});
