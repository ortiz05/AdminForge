import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cronFor, type CronParts } from '@adminforge/web/src/ops/ScheduleEditorPage';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// The schedule editor builds cron from plain choices, previews it, and returns YAML for review.
const base: CronParts = {
  cadence: 'weekly',
  every: 15,
  minute: 7,
  time: '06:15',
  day: '1',
  dayOfMonth: 3,
  custom: '0 6 * * 1',
};

describe('cronFor', () => {
  it.each([
    ['minutes', '*/15 * * * *'],
    ['hourly', '7 * * * *'],
    ['daily', '15 6 * * *'],
    ['weekdays', '15 6 * * 1-5'],
    ['weekly', '15 6 * * 1'],
    ['monthly', '15 6 3 * *'],
    ['custom', '0 6 * * 1'],
  ] as const)('%s → %s', (cadence, expected) => expect(cronFor({ ...base, cadence })).toBe(expected));
});

describe('schedule editor page', () => {
  beforeEach(() => __resetPrefsForTests());

  it('previews the next runs and shows the YAML with next steps', { timeout: 30_000 }, async () => {
    const yaml = '# Made with the schedule editor\nkind: schedule\nid: reports.weekly-x\n';
    const { calls } = renderApp({
      path: '/schedules/new',
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === '/api/definitions'
            ? {
                body: {
                  items: [{ kind: 'report', key: 'identity.inactive-guests', title: 'Inactive guests' }],
                },
              }
            : method === 'POST' && path === '/api/schedules/scaffold'
              ? {
                  body: {
                    yaml,
                    path: 'portal/content/schedules/reports/weekly-x.schedule.yaml',
                    key: 'reports.weekly-x',
                  },
                }
              : undefined,
      ],
    });
    expect(await screen.findByRole('heading', { name: 'New schedule' })).toBeInTheDocument();
    expect(screen.getByText(/0 6 \* \* 1|15 6|6 \* \* 1/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Title'), 'Weekly x');
    await userEvent.click(screen.getByRole('combobox', { name: 'Report' }));
    await userEvent.click(await screen.findByRole('option', { name: /Inactive guests/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create YAML' }));
    expect(
      (await screen.findAllByText('portal/content/schedules/reports/weekly-x.schedule.yaml')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Next steps')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/schedules/scaffold')).toBe(true));
    const sent = calls.find((c) => c.url === '/api/schedules/scaffold')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      title: 'Weekly x',
      cron: '0 6 * * 1',
      job: { kind: 'report', ref: 'identity.inactive-guests' },
    });
    expect(await axeViolations()).toEqual([]);
  });
});
