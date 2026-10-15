import './ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { UserPrefs } from '@adminforge/schemas';
import { overview } from '../../e2e/fixtures/overview';
import { me, NAV } from '../../e2e/fixtures/session';

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

describe('navigation sections open and close', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('a section heading closes and reopens its section, and the choice is saved', async () => {
    const user = userEvent.setup();
    const { puts } = renderApp();
    await screen.findByRole('navigation', { name: 'Primary' });
    const identity = await within(nav()).findByRole('button', { name: 'Identity' });
    expect(identity).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav()).getByRole('link', { name: 'Groups' })).toBeInTheDocument();

    await user.click(identity);
    const closed = within(nav()).getByRole('button', { name: 'Identity (6 pages hidden)' });
    expect(closed).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav()).queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Licences' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('adminforge.prefs')!)).toMatchObject({
      navSections: ['identity'],
    });
    await waitFor(() => expect(puts.at(-1)).toMatchObject({ navSections: ['identity'] }));

    await user.click(closed);
    expect(within(nav()).getByRole('button', { name: 'Identity' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav()).getByRole('link', { name: 'Groups' })).toBeInTheDocument();
  });

  it('a closed section still shows the page you are on', async () => {
    renderApp('/identity/users', { navSections: ['identity'] });
    await screen.findByRole('navigation', { name: 'Primary' });
    const users = await within(nav()).findByRole('link', { name: 'Users' });
    expect(users).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
  });

  it('the icon rail shows every page and has no section toggles', async () => {
    renderApp('/', { navCollapsed: true, navSections: ['identity'] });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav()).findByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(within(nav()).queryByRole('button', { name: /^Identity/ })).not.toBeInTheDocument();
  });
});
