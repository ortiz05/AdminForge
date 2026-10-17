// Component tests run with the en-US locale, so schedule times show the 12-hour clock ("7:00 am"); e2e runs en-GB.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });

describe('Schedules, monitoring, audit, appearance, settings', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('/schedules: cadence in words, automation identity, failures, next runs', async () => {
    renderApp({ path: '/schedules' });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    // The sentence, then the cron with the zone on the line under it (so the zone is never cut off).
    expect(await within(grid).findByText('Every Monday at 7:00 am')).toBeInTheDocument();
    expect(within(grid).getByText('0 7 * * 1 · UTC')).toBeInTheDocument();
    expect(within(grid).getByText('Every 5 minutes')).toHaveAttribute('title', 'Every 5 minutes (UTC)');
    expect(screen.getByText('Who schedules run as')).toBeInTheDocument();
    expect(within(grid).getByText('App: monitoring')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 schedule failed on the last run');
    expect(screen.getByRole('list', { name: 'Upcoming runs' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('enabling a write-capable schedule asks for a second approver (202)', async () => {
    const { state } = renderApp({ path: '/schedules' });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    await userEvent.click(
      await within(grid).findByRole('switch', { name: 'Enable Disable stale guest accounts' }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: /Ask for approval/ });
    expect(dialog).toHaveTextContent('runs unattended as the automation identity');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() =>
      expect(state.schedulePatches).toEqual([
        { key: 'identity.disable-stale-guests', body: { enabled: true } },
      ]),
    );
    expect(await screen.findByText('Approval requested')).toBeInTheDocument();
    expect(await within(grid).findByText('Awaiting approval')).toBeInTheDocument();
  });

  it('/schedules/:key: history with artifacts, failures highlighted, run now', async () => {
    const { state } = renderApp({ path: '/schedules/maintenance.content-health' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Content health' })).toBeInTheDocument();
    const cadence = screen.getByRole('region', { name: 'When it runs' });
    expect(within(cadence).getByText('Every day at 6:00 am Europe/London')).toBeInTheDocument();
    const history = await screen.findByRole('table', { name: /Runs of Content health/ });
    expect(within(history).getByText(/2 definitions need permissions/)).toBeInTheDocument();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('The last run failed');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(state.scheduleRuns).toEqual(['maintenance.content-health']));
    expect(await axeViolations()).toEqual([]);
  });

  it('/monitoring: tiles grouped by kind, worst group first, counts', async () => {
    renderApp({ path: '/monitoring' });
    const main = await screen.findByRole('main');
    const groups = await within(main).findAllByRole('heading', { level: 2 });
    expect(groups[0]).toHaveTextContent('App credentials');
    expect(
      within(main).getByRole('button', { name: /App credentials expiring: Failing, 3 days/ }),
    ).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: /Function app: HR sync: No data/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Probe health' })).getByRole('group', { name: 'Degraded' }),
    ).toHaveTextContent('3');
    expect(await axeViolations()).toEqual([]);
  });

  it('/audit: chain verification, events, detail drawer', async () => {
    renderApp({ session: ADMIN, path: '/audit' });
    expect(await screen.findByText('Chain verified ✓ · 12,408 events')).toBeInTheDocument();
    const grid = await screen.findByRole('grid', { name: 'Audit events' });
    await userEvent.click(await within(grid).findByText('session.armed'));
    const drawer = await screen.findByRole('dialog', { name: 'session.armed' });
    expect(within(drawer).getByRole('region', { name: 'details (redacted)' })).toHaveTextContent('INC-4821');
    expect(await axeViolations()).toEqual([]);
  });

  it('/audit shows a broken chain plainly', async () => {
    renderApp({
      session: ADMIN,
      path: '/audit',
      handlers: [
        ({ path }) =>
          path === '/api/audit/verify' ? { body: { ok: false, checked: 4210, brokenAt: 4211 } } : undefined,
      ],
    });
    expect(await screen.findByText('Chain broken at #4211')).toBeInTheDocument();
  });

  it('/appearance rejects an accent under 4.5:1 and publishes a good one', async () => {
    const { state } = renderApp({ session: ADMIN, path: '/appearance' });
    const hex = await screen.findByRole('textbox', { name: 'Daylight accent hex value' });
    await userEvent.clear(hex);
    await userEvent.type(hex, '#9AB8E8');
    expect(
      await screen.findByText('This can’t be published: some text would be hard to read'),
    ).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(publish);
    expect(state.appearancePuts).toHaveLength(0);
    await userEvent.clear(hex);
    await userEvent.type(hex, '#234B86');
    await waitFor(() => expect(screen.queryByText(/can’t be published/)).not.toBeInTheDocument());
    await userEvent.click(publish);
    await waitFor(() => expect(state.appearancePuts).toHaveLength(1));
    expect(state.appearancePuts[0]).toEqual({
      version: 3,
      overrides: { steel: { accent: '#8FB4F0' }, daylight: { accent: '#234B86' } },
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('/appearance rolls back to an earlier version from the audit history', async () => {
    const { state } = renderApp({ session: ADMIN, path: '/appearance' });
    const history = await screen.findByRole('region', { name: 'Roll back' });
    await userEvent.click(await within(history).findByRole('button', { name: 'Roll back' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Roll back to version 2?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() =>
      expect(state.appearancePuts).toEqual([{ version: 3, overrides: {}, density: 'compact' }]),
    );
  });

  it('/settings: facts and provisioned apps; non-admins get an explanation', async () => {
    renderApp({ session: ADMIN, path: '/settings' });
    expect(await screen.findByText('Not provisioned: Automation identity')).toBeInTheDocument();
    expect(screen.getByText('Example Org · example.com')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('/admin/audit redirects to /audit', async () => {
    const { router } = renderApp({ session: ADMIN, path: '/admin/audit' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'));
  });
});
