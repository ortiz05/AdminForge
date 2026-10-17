import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from '@adminforge/web/src/lib/browser';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import {
  CREATOR_SCHEDULE_KEY,
  creatorSchedule,
  creatorScheduleHandler,
} from '../../../support/web/fixtures/automation';
import { DELIVERY_OPTIONS } from '../../../support/web/fixtures/reports';
import { me } from '../../../support/web/fixtures/session';
import { reportsApi } from '../../../support/web/mock-reports';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// Who a schedule runs as, in the UI (ADR-014): the "Runs as" column, the schedule page's sign-in state for a schedule
// that uses its creator's access (only the creator can sign in), and the "Run as" field on both schedule forms.

const OPERATOR = me({ roles: ['Portal.Reader', 'Portal.Operator'] });

describe('schedules: run as', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the list says who each schedule runs as, and which need a sign-in', async () => {
    const creator = creatorScheduleHandler('needs_sign_in');
    renderApp({ path: '/schedules', session: OPERATOR, handlers: [creator.handler] });
    const grid = await screen.findByRole('grid', { name: 'Schedules' });
    expect(await within(grid).findByText('App: monitoring')).toHaveAttribute(
      'title',
      'app identity monitoring',
    );
    expect(within(grid).getAllByText('Automation').length).toBeGreaterThan(0);
    expect(within(grid).getByText('avery@example.com')).toBeInTheDocument();
    expect(within(grid).getByText('Needs sign-in')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('the creator signs in again from the schedule page (POST /auth/schedule-consent, then Entra)', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const creator = creatorScheduleHandler('needs_sign_in');
    const { calls } = renderApp({
      path: `/schedules/${CREATOR_SCHEDULE_KEY}`,
      session: OPERATOR,
      handlers: [creator.handler],
    });
    expect(await screen.findByText('Runs with avery@example.com’s own access')).toBeInTheDocument();
    expect(screen.getByText('Needs sign-in')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.example.com/authorize?mock=1'));
    expect(creator.consents).toEqual([
      {
        url: `/auth/schedule-consent?returnTo=${encodeURIComponent(`/schedules/${CREATOR_SCHEDULE_KEY}?signedIn=1`)}`,
        body: { key: CREATOR_SCHEDULE_KEY },
      },
    ]);
    expect(calls.find((c) => c.url.startsWith('/auth/schedule-consent'))!.csrf).toBeTruthy();
  });

  it('someone else sees that only the creator can sign in, and no button', async () => {
    const creator = creatorScheduleHandler('not_signed_in', false);
    renderApp({ path: `/schedules/${CREATOR_SCHEDULE_KEY}`, session: OPERATOR, handlers: [creator.handler] });
    expect(await screen.findByText('Not signed in yet')).toBeInTheDocument();
    expect(screen.getByText(/Ask them to open this schedule and sign in/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sign in/ })).not.toBeInTheDocument();
    // Run now waits for the creator, saying so.
    const runNow = screen.getByRole('button', { name: 'Run now' });
    expect(runNow).toHaveAttribute('aria-disabled', 'true');
    expect(runNow).toHaveAccessibleDescription('Waits for avery@example.com to sign in.');
    expect(await axeViolations()).toEqual([]);
  });

  it('report form: "Me" sends the creator identity, then goes to the sign-in for the new schedule', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const reports = reportsApi();
    const creator = creatorScheduleHandler('not_signed_in');
    const identities = ({ method, path }: { method: string; path: string }) => {
      if (method === 'GET' && path === '/api/schedules/delivery-options')
        return { body: { ...DELIVERY_OPTIONS, identities: { apps: ['reports-team'], user: true } } };
      if (method === 'POST' && path === '/api/schedules')
        return { status: 201, body: creatorSchedule('not_signed_in') };
      return undefined;
    };
    const { calls } = renderApp({
      path: '/reports?report=identity.inactive-guests',
      session: OPERATOR,
      handlers: [identities, creator.handler, reports.handler],
    });
    const sheet = await screen.findByRole('dialog', { name: 'Inactive guests' });
    await user.click(await within(sheet).findByRole('button', { name: 'Schedule' }));
    const form = await screen.findByRole('dialog', { name: 'Schedule Inactive guests' });
    await user.click(await within(form).findByRole('combobox', { name: 'Run as' }));
    await user.click(await screen.findByRole('option', { name: 'Me (my own access)' }));
    expect(within(form).getByText(/Microsoft asks you to sign in once/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    await user.click(within(form).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.example.com/authorize?mock=1'));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/schedules')!;
    expect(post.body).toMatchObject({
      identity: { user: 'creator' },
      job: { ref: 'identity.inactive-guests' },
    });
    expect(creator.consents).toHaveLength(1);
  });

  it('schedule editor: names a configured app identity in the YAML request (not for content health)', async () => {
    const { calls } = renderApp({
      path: '/schedules/new',
      session: OPERATOR,
      handlers: [
        ({ method, path }) =>
          method === 'POST' && path === '/api/schedules/scaffold'
            ? { body: { yaml: 'kind: schedule\n', path: 'portal/content/schedules/x.schedule.yaml' } }
            : undefined,
      ],
    });
    expect(await screen.findByRole('heading', { name: 'New schedule' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Title'), 'Probe sweep');
    await userEvent.click(screen.getByRole('combobox', { name: 'Job' }));
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic tests/ }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Run as' }));
    await userEvent.click(await screen.findByRole('option', { name: 'App identity monitoring' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create YAML' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/schedules/scaffold')).toBe(true));
    expect(calls.find((c) => c.url === '/api/schedules/scaffold')!.body).toMatchObject({
      identity: { app: 'monitoring' },
      job: { kind: 'probe' },
    });
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(screen.getByRole('combobox', { name: 'Job' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Content health check' }));
    expect(screen.queryByRole('combobox', { name: 'Run as' })).not.toBeInTheDocument();
  });

  it('report form: if the sign-in can’t start after saving, the schedule still counts as created', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const reports = reportsApi();
    const creator = creatorScheduleHandler('not_signed_in');
    const failing = ({ method, path }: { method: string; path: string }) => {
      if (method === 'GET' && path === '/api/schedules/delivery-options')
        return { body: { ...DELIVERY_OPTIONS, identities: { apps: [], user: true } } };
      if (method === 'POST' && path === '/api/schedules')
        return { status: 201, body: creatorSchedule('not_signed_in') };
      if (method === 'POST' && path === '/auth/schedule-consent')
        return {
          status: 503,
          body: { error: { code: 'unavailable', message: 'Sign-in is unavailable right now.' } },
        };
      return undefined;
    };
    const { calls, router } = renderApp({
      path: '/reports?report=identity.inactive-guests',
      session: OPERATOR,
      handlers: [failing, creator.handler, reports.handler],
    });
    const sheet = await screen.findByRole('dialog', { name: 'Inactive guests' });
    await user.click(await within(sheet).findByRole('button', { name: 'Schedule' }));
    const form = await screen.findByRole('dialog', { name: 'Schedule Inactive guests' });
    await user.click(await within(form).findByRole('combobox', { name: 'Run as' }));
    await user.click(await screen.findByRole('option', { name: 'Me (my own access)' }));
    await user.click(within(form).getByRole('button', { name: 'Create schedule' }));
    expect(await screen.findByText('Sign in for it from its page so it can run.')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/schedules/${CREATOR_SCHEDULE_KEY}`));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/schedules')).toHaveLength(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('back from Entra: the schedule page says it worked and drops the marker from the address', async () => {
    const creator = creatorScheduleHandler('signed_in');
    const { router } = renderApp({
      path: `/schedules/${CREATOR_SCHEDULE_KEY}?signedIn=1`,
      session: OPERATOR,
      handlers: [creator.handler],
    });
    expect(await screen.findByText('Signed in for Inactive guests, with my access')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByText('Needs sign-in')).not.toBeInTheDocument();
  });

  it('the list asks the caller to sign in for their own schedules that wait for it', async () => {
    renderApp({
      path: '/schedules',
      session: OPERATOR,
      handlers: [creatorScheduleHandler('needs_sign_in').handler],
    });
    expect(await screen.findByText('1 schedule needs you to sign in')).toBeInTheDocument();
  });
});
