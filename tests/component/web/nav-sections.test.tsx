import './ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { UserPrefs } from '@adminforge/schemas';
import { overview } from '../../support/web/fixtures/overview';
import { me, NAV } from '../../support/web/fixtures/session';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderApp(path = '/', prefs: UserPrefs = {}) {
  __resetPrefsForTests(prefs);
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/me') return json(me());
      if (url === '/api/nav') return json(NAV);
      if (url === '/api/overview') return json(overview());
      if (url === '/api/me/prefs' && init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(<App router={createAppRouter(queryClient, { initialPath: path })} queryClient={queryClient} />);
  return { puts };
}

const nav = () => screen.getByRole('navigation', { name: 'Primary' });

describe('navigation sections start collapsed, open and close', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('every section starts collapsed; a heading opens it for this visit, and nothing is saved', async () => {
    const user = userEvent.setup();
    const { puts } = renderApp();
    await screen.findByRole('navigation', { name: 'Primary' });
    const identity = await within(nav()).findByRole('button', { name: 'Identity (6 pages hidden)' });
    expect(identity).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(nav()).getByRole('button', { name: /^Microsoft 365 \(\d+ pages hidden\)$/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav()).queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: 'Licences' })).not.toBeInTheDocument();

    await user.click(identity);
    const open = within(nav()).getByRole('button', { name: 'Identity' });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav()).getByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: 'Licences' })).not.toBeInTheDocument();

    await user.click(open);
    expect(within(nav()).getByRole('button', { name: 'Identity (6 pages hidden)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await waitFor(() =>
      expect(within(nav()).queryByRole('link', { name: 'Licences' })).not.toBeInTheDocument(),
    );
    expect(puts.filter((p) => 'navOpenSections' in (p as object))).toEqual([]);
    expect(localStorage.getItem('adminforge.prefs') ?? '').not.toContain('navOpenSections');
  });

  it('an opened section stays open while the person moves between pages', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('navigation', { name: 'Primary' });
    await user.click(await within(nav()).findByRole('button', { name: 'Identity (6 pages hidden)' }));
    await user.click(within(nav()).getByRole('link', { name: 'Groups' }));
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: 'Groups' })).toHaveAttribute('aria-current', 'page'),
    );
    expect(within(nav()).getByRole('button', { name: 'Identity' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav()).getByRole('link', { name: 'Users' })).toBeInTheDocument();
  });

  it('starts collapsed even with sections saved open before (2026-10-23: no longer read)', async () => {
    renderApp('/', { navOpenSections: ['identity', 'm365'], navSections: ['identity'] });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav()).findByRole('button', { name: 'Identity (6 pages hidden)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav()).queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: 'Licences' })).not.toBeInTheDocument();
  });

  it('a collapsed section still shows the page you are on', async () => {
    renderApp('/identity/users');
    await screen.findByRole('navigation', { name: 'Primary' });
    const users = await within(nav()).findByRole('link', { name: 'Users' });
    expect(users).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
  });

  it('the icon rail shows every page and has no section toggles', async () => {
    renderApp('/', { navCollapsed: true });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav()).findByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(within(nav()).queryByRole('button', { name: /^Identity/ })).not.toBeInTheDocument();
  });
});
