import './ensure-route-tree';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { api, ApiRequestError, BACKGROUND_HEADER } from '@adminforge/web/src/lib/api';
import { ACTIVITY_WINDOW_MS, noteActivity } from '@adminforge/web/src/lib/activity';
import { browser } from '@adminforge/web/src/lib/browser';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { overview } from '../../support/web/fixtures/overview';
import { me, NAV } from '../../support/web/fixtures/session';

// IAM-05: a session that ended while nobody was using the tab doesn't start a sign-in by itself — with single
// sign-on that would quietly open a new session and the idle timeout would mean nothing. The person signs in again.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ended = () =>
  json(
    {
      error: {
        code: 'unauthenticated',
        message: 'Your AdminForge session has ended. Sign in to continue.',
        login: '/auth/login?returnTo=%2F',
      },
    },
    401,
  );
const idle = () => noteActivity(Date.now() - ACTIVITY_WINDOW_MS - 1);

describe('a 401 and who caused the request', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    noteActivity();
  });

  it('a background request does not go to sign-in', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ended()),
    );
    idle();
    const err = await api('/api/runs?active=1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 401, signingIn: false, login: '/auth/login?returnTo=%2F' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('a request the person made does', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ended()),
    );
    noteActivity();
    await expect(api('/api/users')).rejects.toMatchObject({ status: 401, signingIn: true });
    expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/login\?returnTo=/));
  });

  it('opening the page is the person’s doing: the first session check signs in even after a quiet spell', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const headers: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/me')
          headers.push((init?.headers as Record<string, string>)[BACKGROUND_HEADER] ?? null);
        return url === '/api/me' ? ended() : json({ ok: true });
      }),
    );
    idle();
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(<App router={createAppRouter(queryClient, { initialPath: '/' })} queryClient={queryClient} />);
    expect(await screen.findByText('Taking you to sign-in…')).toBeInTheDocument();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(headers).toEqual([null]);
  });

  it('the session ends in an unattended tab: “You’re signed out”, and signing in waits for the person', async () => {
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    let signedIn = true;
    const meHeaders: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/me') {
          meHeaders.push((init?.headers as Record<string, string>)[BACKGROUND_HEADER] ?? null);
          return signedIn ? json(me()) : ended();
        }
        if (url === '/api/nav') return json(NAV);
        if (url === '/api/overview') return json(overview());
        return json({ ok: true });
      }),
    );
    noteActivity();
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(<App router={createAppRouter(queryClient, { initialPath: '/' })} queryClient={queryClient} />);
    await screen.findByRole('button', { name: /Account and appearance/ });

    // Idle timeout on the server; the event stream's session.ended (or a focus refetch) checks the session again.
    signedIn = false;
    idle();
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    expect(await screen.findByText('You’re signed out')).toBeInTheDocument();
    expect(screen.getByText('Your AdminForge session has ended. Sign in to continue.')).toBeInTheDocument();
    expect(meHeaders).toEqual([null, '1']);
    expect(assign).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/auth\/login\?returnTo=/)),
    );
  });
});
