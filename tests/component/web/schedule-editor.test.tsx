import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cronFor, type CronParts } from '@adminforge/web/src/ops/ScheduleEditorPage';
import { cadenceProblem, effectiveCadence, HOURLY_ONLY, previewHint } from '@adminforge/web/src/ops/cadence';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// The schedule editor builds cron from plain choices, previews it, and returns YAML for review.
const base: CronParts = {
  cadence: 'weekly',
  every: 15,
  hours: 6,
  minute: 7,
  time: '06:15',
  day: '5',
  days: ['1'],
  dayOfMonth: '3',
  nth: 'L',
  english: 'first Monday of the month at 8:30',
  custom: '0 6 * * 1',
};

describe('cronFor', () => {
  it.each([
    ['minutes', '*/15 * * * *'],
    ['hourly', '7 * * * *'],
    ['hours', '7 */6 * * *'],
    ['daily', '15 6 * * *'],
    ['weekdays', '15 6 * * 1-5'],
    ['weekly', '15 6 * * 1'],
    ['monthly', '15 6 3 * *'],
    ['monthlyWeekday', '15 6 * * 5L'],
    ['english', '30 8 * * 1#1'],
    ['custom', '0 6 * * 1'],
  ] as const)('%s → %s', (cadence, expected) => expect(cronFor({ ...base, cadence })).toBe(expected));

  it('weekly with several days, Monday to Friday as 1-5, the last day of the month', () => {
    expect(cronFor({ ...base, days: ['5', '1', '3'] })).toBe('15 6 * * 1,3,5');
    expect(cronFor({ ...base, days: ['1', '2', '3', '4', '5'] })).toBe('15 6 * * 1-5');
    expect(cronFor({ ...base, cadence: 'monthly', dayOfMonth: 'L' })).toBe('15 6 L * *');
    expect(cronFor({ ...base, cadence: 'monthlyWeekday', nth: '1', day: '1' })).toBe('15 6 * * 1#1');
    expect(cronFor({ ...base, cadence: 'english', english: 'every tuesdy' })).toBe('');
    // No day ticked is no schedule (the field says so), never a quiet Monday.
    expect(cronFor({ ...base, days: [] })).toBe('');
  });

  it('problems the cadence field shows: English, cron, no day, and more than hourly for reports', () => {
    expect(cadenceProblem({ ...base, days: [] })).toBe('Tick at least one day.');
    expect(cadenceProblem({ ...base, cadence: 'custom', custom: '61 * * * *' })).toMatch(/minute "61"/);
    expect(cadenceProblem({ ...base, cadence: 'english', english: 'every 15 minutes' })).toBeUndefined();
    expect(
      cadenceProblem({ ...base, cadence: 'english', english: 'every 15 minutes' }, { hourlyOnly: true }),
    ).toBe(HOURLY_ONLY);
    expect(cadenceProblem({ ...base, cadence: 'custom', custom: '0,30 * * * *' }, { hourlyOnly: true })).toBe(
      HOURLY_ONLY,
    );
    expect(cadenceProblem({ ...base, cadence: 'hours' }, { hourlyOnly: true })).toBeUndefined();
    expect(previewHint({ ...base, cadence: 'english', english: '' })).toBe('Type when it should run, above.');
  });

  it('names a schedule by the shape its English or cron really has', () => {
    expect(effectiveCadence({ ...base, cadence: 'english', english: 'every 4 hours' })).toBe('hours');
    expect(effectiveCadence({ ...base, cadence: 'custom', custom: '0 7 * * 1-5' })).toBe('weekdays');
    expect(effectiveCadence({ ...base, cadence: 'custom', custom: '0 9-17 * * *' })).toBe('custom');
  });
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
