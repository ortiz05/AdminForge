import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { FIXED_NOW, me } from '../../support/web/fixtures/session';
import { reportsApi } from '../../support/web/mock-reports';
import { axeViolations } from '../axe';
import { renderApp } from '../web/automation/render';

// The report catalogue (/reports) in the real app and shell against the mocked BFF: KPIs, tag filters in the URL,
// keyboard row open, the details sheet, the schedule form's focus handling and request, and what a Reader sees.

function renderReports(path: string, session = me()) {
  const reports = reportsApi();
  const view = renderApp({ path, session, handlers: [reports.handler] });
  return { ...view, reports };
}

// Each test renders the whole page (router, DataTable, side panel); under the full parallel suite that can take
// longer than vitest's 5 s default, so the budget is raised rather than the coverage cut.
describe('Reports catalogue', { timeout: 20_000 }, () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    // The form's default time zone is the browser's; pin it so the request is stable.
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    process.env.TZ = tz;
  });
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows KPIs, filters by a row’s tag, and opens a report from the keyboard', async () => {
    const user = userEvent.setup();
    const { router } = renderReports('/reports');
    const grid = await screen.findByRole('grid', { name: 'Reports' });
    expect(await within(grid).findByText('Inactive users')).toBeInTheDocument();
    const kpis = screen.getByRole('region', { name: 'Report summary' });
    expect(within(kpis).getByRole('group', { name: 'Scheduled' })).toHaveTextContent('3');
    expect(within(kpis).getByRole('group', { name: 'Failing schedules' })).toHaveTextContent('1');
    expect(screen.getByText('10 reports')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    const guests = within(grid)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Inactive guests'))!;
    await user.click(within(guests).getByRole('button', { name: 'Show reports tagged guests' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tag: 'guests' }));
    expect(await screen.findByText('1 of 10 reports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Tag: guests' })).toBeInTheDocument();

    const row = within(grid)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Inactive guests'))!;
    row.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ report: 'identity.inactive-guests' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Inactive guests' });
    expect(within(sheet).getByText(/Not scheduled\./)).toBeInTheDocument();
    expect(await within(sheet).findByRole('list', { name: 'Export columns' })).toHaveTextContent('Object ID');
  });

  it('the schedule form takes focus, gives it back on Cancel, and posts the defaults', async () => {
    const user = userEvent.setup();
    const { reports, router } = renderReports('/reports?report=identity.inactive-guests');
    const sheet = await screen.findByRole('dialog', { name: 'Inactive guests' });
    const schedule = await within(sheet).findByRole('button', { name: 'Schedule' });
    await user.click(schedule);

    const form = await screen.findByRole('dialog', { name: 'Schedule Inactive guests' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveValue('Inactive guests, weekly');
    expect(within(form).getByText(/Runs every Monday at 06:00 UTC/)).toBeInTheDocument();
    expect(await within(form).findByRole('combobox', { name: 'Email the file to' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('schedule'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Inactive guests' })).getByRole('button', {
          name: 'Schedule',
        }),
      ).toHaveFocus(),
    );

    await user.click(
      within(screen.getByRole('dialog', { name: 'Inactive guests' })).getByRole('button', {
        name: 'Schedule',
      }),
    );
    const again = await screen.findByRole('dialog', { name: 'Schedule Inactive guests' });
    await user.clear(within(again).getByRole('textbox', { name: 'Name' }));
    await user.click(within(again).getByRole('button', { name: 'Create schedule' }));
    expect(await within(again).findByText('Give the schedule a name.')).toBeInTheDocument();
    expect(reports.state.posts).toEqual([]);

    await user.type(within(again).getByRole('textbox', { name: 'Name' }), 'Guests for the service desk');
    await user.click(within(again).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() =>
      expect(reports.state.posts).toEqual([
        {
          title: 'Guests for the service desk',
          cron: '0 6 * * 1',
          timezone: 'UTC',
          job: { kind: 'report', ref: 'identity.inactive-guests', format: 'xlsx', retain: 26 },
        },
      ]),
    );
    expect(await screen.findByText('Schedule created')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Schedules of Inactive guests' });
    expect(await within(list).findByText('Guests for the service desk')).toBeInTheDocument();
  });

  it('a Reader sees why scheduling is unavailable and no Edit or Delete', async () => {
    renderReports('/reports?report=identity.inactive-users', me({ roles: ['Portal.Reader'] }));
    const sheet = await screen.findByRole('dialog', { name: 'Inactive users' });
    expect(
      await within(sheet).findByText('Scheduling a report needs the Portal Operator role.'),
    ).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });
});
