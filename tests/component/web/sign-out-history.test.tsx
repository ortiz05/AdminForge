import './ensure-route-tree';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { browser } from '@adminforge/web/src/lib/browser';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import {
  __resetHistoryForTests,
  historyKey,
  readHistory,
  recordRun,
} from '@adminforge/web/src/query/history';
import { overview } from '../../e2e/fixtures/overview';
import { me, NAV } from '../../e2e/fixtures/session';

// The shell keys Query Studio history to the signed-in user and removes it when they sign out (L15).
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sign-out clears Query Studio history', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    __resetHistoryForTests(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('history is stored under the signed-in user and gone after Sign out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/me') return json(me());
        if (url === '/api/nav') return json(NAV);
        if (url === '/api/overview') return json(overview());
        if (url === '/auth/logout') return json({ redirect: '/signed-out' });
        return json({ ok: true });
      }),
    );
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(<App router={createAppRouter(queryClient, { initialPath: '/' })} queryClient={queryClient} />);
    const user = userEvent.setup();
    const menu = await screen.findByRole('button', { name: /Account and appearance/ });
    recordRun({ source: 'resourceGraph', query: 'resources | take 1', ranAt: '2026-10-15T12:00:00.000Z' });
    expect(localStorage.getItem(historyKey(me().user.oid))).toContain('take 1');

    await user.click(menu);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/signed-out'));
    expect(localStorage.getItem(historyKey(me().user.oid))).toBeNull();
    expect(readHistory()).toEqual([]);
  });
});
