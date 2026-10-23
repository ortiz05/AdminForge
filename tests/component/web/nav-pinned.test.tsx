import './ensure-route-tree';
import { render, screen, within } from '@testing-library/react';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { overview } from '../../support/web/fixtures/overview';
import { me, NAV } from '../../support/web/fixtures/session';

// A pinned navigation item (`pinned: true` in navigation.yaml: Monitoring, News and changes) stays in the rail while
// its section is collapsed, like the page you're on — always one click away.
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const PINNED = {
  sections: NAV.sections.map((s) =>
    s.key === 'identity'
      ? { ...s, items: s.items.map((i) => (i.label === 'Groups' ? { ...i, pinned: true } : i)) }
      : s,
  ),
};

describe('pinned navigation items', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stay visible in a collapsed section; the rest of it stays hidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/me') return json(me());
        if (url === '/api/nav') return json(PINNED);
        if (url === '/api/overview') return json(overview());
        return json({ ok: true });
      }),
    );
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(<App router={createAppRouter(queryClient, { initialPath: '/' })} queryClient={queryClient} />);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const identity = await within(nav).findByRole('button', { name: /^Identity \(5 pages hidden\)$/ });
    expect(identity).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).getByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });
});
