import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { fileOnlyNote } from '@adminforge/web/src/ops/ScheduleControls';
import { me } from '../../../support/web/fixtures/session';
import type { MockHandler } from '../../../support/web/mock-handler';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// F-10: Run now on a switched-off schedule runs the job but sends nothing — a report writes its file only — and the
// control says so: in the button's description before, and in the toast after.

const OPERATOR = me({ roles: ['Portal.Reader', 'Portal.Operator'] });

/** POST /api/schedules/:key/run answered as the API does (the shared mock doesn't say `fileOnly`). */
const runAnswer =
  (key: string, extra: Record<string, unknown>): MockHandler =>
  ({ method, path }) =>
    method === 'POST' && path === `/api/schedules/${key}/run`
      ? { status: 202, body: { scheduleRunId: 'sr-x', ...extra } }
      : undefined;
const REPORT_OFF =
  'This schedule is disabled, so Run now only writes the file: it sends no email, Teams message or notification.';

describe('Run now on a switched-off schedule', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('says before and after that a report only writes the file', async () => {
    const { calls } = renderApp({
      path: '/schedules',
      session: OPERATOR,
      handlers: [runAnswer('reports.licence-usage-monthly', { fileOnly: true })],
    });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    const off = await within(grid).findByRole('button', { name: 'Run Monthly licence usage now' });
    expect(off).toHaveAccessibleDescription(REPORT_OFF);
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(off);
    expect(await screen.findByText('Monthly licence usage started')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The schedule is disabled, so this run only writes the file and sends nothing. To send it, enable the schedule and run it again.',
      ),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/schedules/reports.licence-usage-monthly/run',
    ]);
  });

  it('a schedule that is on says nothing of the sort', async () => {
    const { state } = renderApp({ path: '/schedules', session: OPERATOR });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    const on = await within(grid).findByRole('button', {
      name: 'Run Weekly app credential expiry report now',
    });
    expect(on).not.toHaveAccessibleDescription(/disabled/);
    await userEvent.click(on);
    await waitFor(() => expect(state.scheduleRuns).toEqual(['reports.app-credential-expiry']));
    expect(
      await screen.findByText('It runs as the automation identity; the result appears in its history.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only writes the file/)).not.toBeInTheDocument();
  });

  it('other jobs: no email, Teams message or notification; write-capable jobs: nothing (Run now refuses them)', () => {
    const job = { kind: 'probe', ref: 'probes.x', params: null };
    expect(fileOnlyNote({ enabled: false, writeCapable: false, job })).toBe(
      'This schedule is disabled, so Run now sends no email, Teams message or notification.',
    );
    expect(fileOnlyNote({ enabled: true, writeCapable: false, job })).toBeNull();
    expect(fileOnlyNote({ enabled: false, writeCapable: true, job })).toBeNull();
  });

  it('the toast follows the answer, not the page: a schedule enabled a moment ago sends as usual', async () => {
    // The list still says "disabled", but the API answers without fileOnly (someone enabled it meanwhile).
    renderApp({
      path: '/schedules',
      session: OPERATOR,
      handlers: [runAnswer('reports.licence-usage-monthly', {})],
    });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    await userEvent.click(await within(grid).findByRole('button', { name: 'Run Monthly licence usage now' }));
    expect(
      await screen.findByText('It runs as the automation identity; the result appears in its history.'),
    ).toBeInTheDocument();
  });

  it('the schedule page says it under the switch while the schedule is disabled', async () => {
    renderApp({ path: '/schedules/reports.licence-usage-monthly', session: OPERATOR });
    expect(await screen.findByText('Run now only writes the file until you enable it.')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
