import './ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { browser } from '@adminforge/web/src/lib/browser';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { overview } from '../../support/web/fixtures/overview';
import { armedMe, FIXED_NOW, me, NAV } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Options {
  session?: MeResponse;
  path?: string;
  /** Override any response by URL. */
  respond?: (url: string, init?: RequestInit) => Response | undefined;
}

function renderApp({ session = me(), path = '/', respond }: Options = {}) {
  let current = session;
  const calls: Array<{ method: string; url: string; body?: string; csrf?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: init?.body as string | undefined,
        csrf: (init?.headers as Record<string, string>)?.['X-AdminForge-CSRF'],
      });
      const custom = respond?.(url, init);
      if (custom) return custom;
      if (url === '/api/me') return json(current);
      if (url === '/api/nav') return json(NAV);
      if (url === '/api/overview') return json(overview());
      if (url === '/auth/disarm') {
        current = { ...current, mode: 'read', armedUntil: null };
        return json({ ok: true });
      }
      if (url === '/auth/arm/extend')
        return json({ armedUntil: new Date(Date.now() + 90 * 60_000).toISOString() });
      if (url.startsWith('/auth/arm?')) return json({ redirect: '/?armed=1' });
      if (url === '/auth/logout') return json({ redirect: '/signed-out' });
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  render(<App router={router} queryClient={queryClient} />);
  return { calls, router };
}

describe('AppShell (real routes, mocked API)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    document.documentElement.dataset.mode = 'read';
    // Fixture times (armedUntil, run timestamps) are relative to FIXED_NOW: fake only Date, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the session, then renders rail, navigation from /api/nav, run dock and the overview', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Org' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    // Sections start collapsed; opening one shows its pages.
    await userEvent.click(
      await within(nav).findByRole('button', { name: /^Identity \(\d+ pages hidden\)$/ }),
    );
    expect(await within(nav).findByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      '/identity/users',
    );
    expect(within(nav).getByRole('link', { name: 'Tenant overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Runs' })).toBeInTheDocument();
    expect(document.documentElement.dataset.mode).toBe('read');
    expect(await axeViolations()).toEqual([]);
  });

  it('armed: sets <html data-mode="armed">, shows the countdown; Disarm returns to read-only', async () => {
    const { calls } = renderApp({ session: armedMe() });
    expect(await screen.findByText(/Armed · \d+:\d{2}/)).toBeInTheDocument();
    expect(document.documentElement.dataset.mode).toBe('armed');
    await userEvent.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => expect(document.documentElement.dataset.mode).toBe('read'));
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(await screen.findByText('Write access ended')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/auth/disarm')).toMatchObject({
      method: 'POST',
      csrf: 'e2e-csrf-token',
    });
  });

  it('Extend updates the countdown and is offered once', async () => {
    renderApp({ session: armedMe() });
    await userEvent.click(await screen.findByRole('button', { name: 'Extend' }));
    expect(await screen.findByText(/Write access extended until/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Extend' })).not.toBeInTheDocument());
    expect(screen.getByText(/Armed · 1:(29|30):\d{2}/)).toBeInTheDocument();
  });

  it('arming posts {minutes, reason} and follows the redirect', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const { calls } = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Arm write access' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'CHG-1042 rotate secret');
    await userEvent.click(screen.getByRole('button', { name: 'Arm now' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?armed=1'));
    // returnTo brings the engineer back to the same page (and any open playbook drawer) after step-up.
    const arm = calls.find((c) => c.url === '/auth/arm?returnTo=%2F')!;
    expect(arm.method).toBe('POST');
    expect(JSON.parse(arm.body!)).toEqual({ minutes: 60, reason: 'CHG-1042 rotate secret' });
    assign.mockRestore();
  });

  it('Ctrl+K opens the command palette; choosing a page navigates there', async () => {
    const { router } = renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Example Org' });
    await screen.findByRole('button', { name: /^Identity \(\d+ pages hidden\)$/ });
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.type(within(palette).getByRole('combobox'), 'Arc servers');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/azure/arc'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Arc servers' })).toBeInTheDocument();
    expect(screen.getByText(/Hybrid servers connected through Azure Arc/)).toBeInTheDocument();
  });

  it('the command palette switches theme', async () => {
    renderApp();
    await screen.findByRole('heading', { level: 1, name: 'Example Org' });
    await userEvent.click(screen.getByRole('button', { name: /Jump to a page or action/ }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.type(within(palette).getByRole('combobox'), 'Daylight');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('daylight'));
  });

  it('the user menu changes density and mirrors it to localStorage', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /Account and appearance/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(JSON.parse(localStorage.getItem('adminforge.prefs')!)).toMatchObject({ density: 'compact' });
  });

  it('collapses the navigation to icons', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse navigation' }));
    expect(document.documentElement.dataset.nav).toBe('collapsed');
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens the inspector from ?inspect= and closes it with Escape', async () => {
    const id = '3f2a8c71-5d0e-4b6a-9e1f-0c4d2b7a9c1d';
    const { router } = renderApp({ path: `/?inspect=user:${id}` });
    const drawer = await screen.findByRole('dialog', { name: 'User 3f2a…9c1d' });
    expect(drawer).toHaveTextContent('Inspector');
    expect(within(drawer).getByRole('button', { name: `Copy Object ID ${id}` })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('inspect', `user:${id}`));
  });

  it('explains planned pages', async () => {
    renderApp({ path: '/identity/users' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByText(/Disable sign-in, revoke sessions/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('says plainly when a page does not exist', async () => {
    renderApp({ path: '/nope' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'There’s no page at this address' }),
    ).toBeInTheDocument();
  });

  it('shows the developer toolbar only in mock mode, and it posts mock state', async () => {
    const { calls } = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Mock session' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Arm 30 min' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/auth/mock/state')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === '/auth/mock/state')!.body!)).toEqual({ armedMinutes: 30 });
  });

  it('hides the developer toolbar with real sign-in', async () => {
    renderApp({ session: me({ authMode: 'entra' }) });
    await screen.findByRole('heading', { level: 1, name: 'Example Org' });
    expect(screen.queryByRole('button', { name: 'Mock session' })).not.toBeInTheDocument();
  });

  it('a session failure other than sign-in shows the error with its code', async () => {
    renderApp({
      respond: (url) =>
        url === '/api/me'
          ? json(
              {
                error: {
                  code: 'db_unavailable',
                  message: 'The session store is not reachable.',
                  correlationId: 'aa11bb22-0000-4000-8000-000000000002',
                },
              },
              503,
            )
          : undefined,
    });
    expect(await screen.findByText('AdminForge couldn’t load your session')).toBeInTheDocument();
    expect(screen.getByText('db_unavailable')).toBeInTheDocument();
  });

  it('a 401 sends the browser to sign in', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    renderApp({
      respond: (url) =>
        url === '/api/me'
          ? json(
              { error: { code: 'unauthenticated', message: 'Sign in.', login: '/auth/login?returnTo=%2F' } },
              401,
            )
          : undefined,
    });
    expect(await screen.findByText('Taking you to sign-in…')).toBeInTheDocument();
    expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/login\?returnTo=/));
    assign.mockRestore();
  });
});

describe('Overview page', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows KPIs, service health (healthy folded), domains, licences and provenance', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Org' })).toBeInTheDocument();
    const kpis = screen.getByRole('region', { name: 'Key figures' });
    expect(within(kpis).getByRole('group', { name: 'Users' })).toHaveTextContent('12,408');
    expect(within(kpis).getByRole('group', { name: 'Services with issues' })).toHaveTextContent(
      'Exchange Online +1',
    );

    const services = screen.getByRole('list', { name: 'Services' });
    expect(within(services).getByText('Exchange Online')).toBeInTheDocument();
    expect(within(services).queryByText('Microsoft Teams')).not.toBeInTheDocument();
    await userEvent.click(within(services).getByRole('button', { name: 'Show all' }));
    expect(within(services).getByText('Microsoft Teams')).toBeInTheDocument();

    expect(screen.getByRole('list', { name: 'Domains' })).toHaveTextContent('example.com');
    const grid = screen.getByRole('grid', { name: 'Licence subscriptions' });
    expect(within(grid).getAllByRole('row')).toHaveLength(8);
    expect(within(grid).getAllByRole('row')[1]).toHaveTextContent('Power BI Pro');
    expect(within(grid).getAllByRole('row')[1]).toHaveTextContent('No seats left');
    expect(screen.getByText('/subscribedSkus')).toBeInTheDocument();
  });

  it('a refused service-health call degrades to a panel error, not a page error', async () => {
    const { overviewWithoutHealth } = await import('../../support/web/fixtures/overview');
    renderApp({ respond: (url) => (url === '/api/overview' ? json(overviewWithoutHealth()) : undefined) });
    expect(await screen.findByText('Service health isn’t available')).toBeInTheDocument();
    expect(screen.getByText('Needs ServiceHealth.Read.All')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Services with issues' })).toHaveTextContent('Unavailable');
    expect(screen.getByRole('grid', { name: 'Licence subscriptions' })).toBeInTheDocument();
  });

  it('shows an actionable error when the overview fails, and retries', async () => {
    let fail = true;
    const { calls } = renderApp({
      respond: (url) =>
        url === '/api/overview' && fail
          ? json(
              {
                error: {
                  code: 'upstream_unavailable',
                  message: 'Microsoft Graph did not answer in time.',
                  hint: 'Try again in a minute.',
                  correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
                },
              },
              503,
            )
          : undefined,
    });
    expect(await screen.findByText('The tenant overview didn’t load')).toBeInTheDocument();
    expect(screen.getByText('upstream_unavailable')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Org' })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/overview').length).toBeGreaterThanOrEqual(2);
  });
});
