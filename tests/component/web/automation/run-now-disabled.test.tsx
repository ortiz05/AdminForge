import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { fileOnlyNote } from '@adminforge/web/src/ops/ScheduleControls';
import { me } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// F-10: Run now on a switched-off schedule runs the job but sends nothing — a report writes its file only — and the
// control says so: in the button's description before, and in the toast after.

const OPERATOR = me({ roles: ['Portal.Reader', 'Portal.Operator'] });
const REPORT_OFF =
  'The schedule is off, so Run now writes the file only: nothing is emailed, posted to Teams or notified.';

describe('Run now on a switched-off schedule', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('says before and after that a report writes the file only', async () => {
    const { state } = renderApp({ path: '/schedules', session: OPERATOR });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    const off = await within(grid).findByRole('button', { name: 'Run Monthly licence usage now' });
    expect(off).toHaveAccessibleDescription(REPORT_OFF);
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(off);
    await waitFor(() => expect(state.scheduleRuns).toEqual(['reports.licence-usage-monthly']));
    expect(await screen.findByText('Monthly licence usage started')).toBeInTheDocument();
    expect(screen.getByText(`${REPORT_OFF} The result appears in its history.`)).toBeInTheDocument();
  });

  it('a schedule that is on says nothing of the sort', async () => {
    const { state } = renderApp({ path: '/schedules', session: OPERATOR });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    const on = await within(grid).findByRole('button', {
      name: 'Run Weekly app credential expiry report now',
    });
    expect(on).not.toHaveAccessibleDescription(/off/);
    await userEvent.click(on);
    await waitFor(() => expect(state.scheduleRuns).toEqual(['reports.app-credential-expiry']));
    expect(
      await screen.findByText('It runs as the automation identity; the result appears in its history.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/writes the file only/)).not.toBeInTheDocument();
  });

  it('other jobs: no email, Teams message or notification', () => {
    expect(fileOnlyNote({ enabled: false, job: { kind: 'probe', ref: 'probes.x', params: null } })).toBe(
      'The schedule is off, so Run now sends no email, Teams message or notification.',
    );
    expect(fileOnlyNote({ enabled: true, job: { kind: 'report', ref: 'r', params: null } })).toBeNull();
  });
});
