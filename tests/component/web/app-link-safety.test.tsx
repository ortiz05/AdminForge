import './ensure-route-tree';
import { render, screen, within } from '@testing-library/react';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { AppLink, contentKeyOf, followHref } from '@adminforge/web/src/lib/links';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me, NAV } from '../../support/web/fixtures/session';

// AppLink and useNavigateHref (followHref) are where the portal's in-app links and navigations go through: widgets get
// AppLink as `runtime.Link`, row and menu actions call `runtime.navigate`. Their hrefs often come from content
// templates filled with tenant data, so both apply safeUrl: `/\evil.com` and `//evil.com` (which the router rendered as
// an anchor the browser resolves to another site), `javascript:` and relative paths never become an anchor or a
// navigation (S-11).
const UNSAFE = [
  '/\\evil.example.com',
  '//evil.example.com',
  '//evil.example.com/p/identity.users',
  '/\t/evil.example.com',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<b>x</b>',
  'https:///evil.example.com',
  'https:/\\evil.example.com',
  'relative/path',
  '',
];

const ORIGIN = 'http://localhost';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AppLink', () => {
  it.each(UNSAFE)('%j shows its content as text, not a link', (href) => {
    const { container } = render(
      <AppLink href={href} className="font-medium">
        Open target
      </AppLink>,
    );
    expect(screen.getByText('Open target')).toHaveClass('font-medium');
    expect(container.querySelector('a')).toBeNull();
  });

  it('a safe external href is a new-tab anchor without a referrer', () => {
    render(<AppLink href="https://learn.microsoft.com/">Docs</AppLink>);
    const docs = screen.getByRole('link', { name: 'Docs' });
    expect(docs).toHaveAttribute('href', 'https://learn.microsoft.com/');
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noreferrer');
  });
});

describe('contentKeyOf', () => {
  it('reads the key of a content page, and refuses one that is not valid percent-encoding', () => {
    expect(contentKeyOf('/p/identity.users')).toBe('identity.users');
    expect(contentKeyOf('/p/identity.user%2Ex')).toBe('identity.user.x');
    expect(contentKeyOf('/p/%E0')).toBeNull();
    expect(contentKeyOf('/runs')).toBeNull();
  });
});

describe('followHref (useNavigateHref)', () => {
  it.each(UNSAFE)('%j neither navigates nor opens a window', (href) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const router = { navigate: vi.fn() };
    expect(followHref(router, href)).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('a safe in-app href goes through the router', () => {
    const router = { navigate: vi.fn() };
    expect(followHref(router, '/p/identity.users?userType=Guest', { replace: true })).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith({ href: '/p/identity.users?userType=Guest', replace: true });
  });

  it('a safe external href opens a new tab with no opener', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const router = { navigate: vi.fn() };
    expect(followHref(router, 'https://entra.microsoft.com/')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://entra.microsoft.com/', '_blank', 'noopener,noreferrer');
    expect(router.navigate).not.toHaveBeenCalled();
  });
});

// The real router on a /p/<key> page: drill-down hrefs templated from data become same-site anchors when safe, and
// the rest stay text — whatever the widget.
describe('drill-down links on a content page', () => {
  const ROWS = [
    { id: 'safe', name: 'Example Portal', target: '/p/identity.app?id=safe' },
    { id: 'backslash', name: 'Backslash app', target: '/\\evil.example.com' },
    { id: 'protocol', name: 'Protocol-relative app', target: '//evil.example.com' },
    { id: 'script', name: 'Script app', target: 'javascript:alert(1)' },
    { id: 'malformed', name: 'Malformed key app', target: '/p/%E0' },
  ];
  const PAGE = {
    kind: 'dashboard',
    id: 'test.links',
    version: '1.0.0',
    sha256: 'l',
    title: 'Application links',
    owner: 'test',
    template: 'dashboard',
    datasources: { apps: { source: 'graph', request: { method: 'GET', path: '/applications' } } },
    layout: [
      { widget: 'list', title: 'App list', data: 'apps.value', primary: 'name', href: '${ row.target }' },
      {
        widget: 'statusGrid',
        title: 'App states',
        data: 'apps.value',
        label: 'name',
        status: 'id',
        href: '${ row.target }',
      },
      { widget: 'kpi', label: 'Unsafe KPI', data: 'apps.count', href: '${ apps.kpiTarget }' },
    ],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });

  it(
    'only safe targets become anchors, and every anchor stays on this site',
    { timeout: 20_000 },
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = new URL(url, ORIGIN);
          if (u.pathname === '/api/me') return json(me());
          if (u.pathname === '/api/nav') return json(NAV);
          if (u.pathname === '/api/definitions/dashboard/test.links') return json(PAGE);
          if (u.pathname.startsWith('/api/definitions/'))
            return json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
          if (u.pathname === '/api/datasources/execute-many')
            return json({
              results: {
                apps: {
                  data: { value: ROWS, count: ROWS.length, kpiTarget: '/\\evil.example.com' },
                  provenance: { service: 'graph', path: '/applications', ms: 40 },
                },
              },
            });
          if (u.pathname === '/api/me/capabilities')
            return json({ features: {}, roles: { active: [], eligible: [] } });
          if (u.pathname === '/api/probes') return json({ items: [] });
          return json({ ok: true });
        }),
      );
      const queryClient = createQueryClient();
      queryClient.setDefaultOptions({ queries: { retry: false } });
      render(
        <App
          router={createAppRouter(queryClient, { initialPath: '/p/test.links' })}
          queryClient={queryClient}
        />,
      );

      const list = await screen.findByRole('list', { name: 'App list' });
      const grid = await screen.findByRole('list', { name: 'App states' });
      for (const region of [list, grid]) {
        const safe = await within(region).findByRole('link', { name: /Example Portal/ });
        expect(safe).toHaveAttribute('href', '/p/identity.app?id=safe');
        // A key that isn't valid percent-encoding neither crashes the link nor the page.
        expect(within(region).getByText('Malformed key app')).toBeVisible();
        for (const name of ['Backslash app', 'Protocol-relative app', 'Script app']) {
          expect(within(region).getByText(name)).toBeVisible();
          expect(within(region).getByText(name).closest('a')).toBeNull();
        }
      }
      expect(screen.queryByRole('alert')).toBeNull();
      expect(await screen.findByRole('group', { name: 'Unsafe KPI' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Unsafe KPI' }).closest('a')).toBeNull();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href')!;
        const resolved = new URL(href, `${ORIGIN}/p/test.links`);
        if (resolved.origin !== ORIGIN) expect(a).toHaveAttribute('target', '_blank');
        expect(resolved.protocol).toMatch(/^(https?|mailto):$/);
      }
    },
  );
});
