import './ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me, NAV } from '../../e2e/fixtures/session';
import { axeViolations } from '../axe';
import { DEFINITIONS, guid, NEXT_PAGE, RESULTS } from './renderer-fixtures';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

interface Options {
  session?: MeResponse;
  caps?: unknown;
  respond?: (url: string, init?: RequestInit) => Response | undefined;
}

function renderAt(path: string, { session = me(), caps, respond }: Options = {}) {
  const calls: Call[] = [];
  const views: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const custom = respond?.(url, init);
      if (custom) return custom;
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/me') return json(session);
      if (u.pathname === '/api/nav') return json(NAV);
      const def = /^\/api\/definitions\/([a-z]+)\/(.+)$/.exec(u.pathname);
      if (def) {
        const hit = DEFINITIONS[`${def[1]}/${decodeURIComponent(def[2]!)}`];
        return hit ? json(hit) : json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
      }
      if (u.pathname === '/api/datasources/execute-many') {
        const names = (body as { datasources: string[] }).datasources;
        return json({ results: Object.fromEntries(names.map((n) => [n, RESULTS[n] ?? { error: { code: 'nope', message: `No result for ${n}` } }])) });
      }
      if (u.pathname === '/api/datasources/execute') return json(NEXT_PAGE);
      if (u.pathname === '/api/me/capabilities') return json(caps ?? { features: {}, roles: { active: [], eligible: [] } });
      if (u.pathname === '/api/views' && method === 'GET') return json({ items: views });
      if (u.pathname === '/api/views' && method === 'POST') {
        const v = { id: `v${views.length + 1}`, mine: true, owner: 'me', ...(body as object) };
        views.push(v);
        return json(v, 201);
      }
      if (u.pathname === '/api/search') return json({ query: u.searchParams.get('q'), results: [{ type: 'user', title: 'Adele Vance', subtitle: 'adele@example.com', href: `/p/test.person?id=${guid(1)}` }], sources: {} });
      if (u.pathname === '/api/probes') return json({ items: [] });
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  render(<App router={router} queryClient={queryClient} />);
  const search = () => router.state.location.search as Record<string, unknown>;
  return { calls, router, search };
}

const decode = (v: unknown) => {
  const s = String(v).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(s + '='.repeat((4 - (s.length % 4)) % 4)));
};

const executeMany = (calls: Call[]) => calls.filter((c) => c.url === '/api/datasources/execute-many');

describe('content renderer (/p/$key)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders a list-detail page: header, filters, KPI strip, table, provenance — one execute-many for what is shown', async () => {
    const { calls } = renderAt('/p/test.users');
    expect(await screen.findByRole('heading', { level: 1, name: 'People' })).toBeInTheDocument();
    const grid = await screen.findByRole('grid', { name: 'People' });
    expect(await within(grid).findByText('Adele Vance')).toBeInTheDocument();
    const strip = screen.getByRole('region', { name: 'Key figures' });
    expect(within(strip).getByRole('group', { name: 'Members' })).toHaveTextContent('2');
    expect(await within(strip).findByText('Needs review')).toBeInTheDocument();
    expect(screen.getAllByText('/users').length).toBeGreaterThan(0);
    // Unknown widget types are a visible configuration problem, not a crash.
    expect(screen.getByText(/The “nope” widget can’t be shown/)).toBeInTheDocument();
    // Filter bar from params; the server search box is bound to `q`.
    const filters = screen.getByRole('search', { name: 'Filters' });
    expect(within(filters).getByRole('button', { name: 'Type' })).toBeInTheDocument();
    expect(within(filters).getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
    const many = executeMany(calls);
    expect(many).toHaveLength(1);
    expect(many[0]!.body).toEqual({ page: 'test.users', version: '1.0.0', datasources: ['users', 'counts'], params: {} });
    expect(await axeViolations()).toEqual([]);
  });

  it('a facet writes the param to the URL and re-queries with it', async () => {
    const user = userEvent.setup();
    const { calls, search } = renderAt('/p/test.users');
    const filters = await screen.findByRole('search', { name: 'Filters' });
    await screen.findByText('Adele Vance');
    await user.click(within(filters).getByRole('button', { name: 'Type' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Guest' }));
    await waitFor(() => expect(search().userType).toBe('Guest'));
    await waitFor(() => expect(executeMany(calls).some((c) => (c.body as { params: { userType?: string } }).params.userType === 'Guest')).toBe(true));
    expect(within(screen.getByRole('list', { name: 'Active filters' })).getByText('Guest')).toBeInTheDocument();
  });

  it('loads the next page of a cursor datasource with execute', async () => {
    const user = userEvent.setup();
    const { calls } = renderAt('/p/test.users');
    const grid = await screen.findByRole('grid', { name: 'People' });
    await within(grid).findByText('Adele Vance');
    // Near the end of three loaded rows the table asks for more; the button is there too.
    await waitFor(() => expect(calls.some((c) => c.url === '/api/datasources/execute')).toBe(true));
    expect(calls.find((c) => c.url === '/api/datasources/execute')!.body).toEqual({ page: 'test.users', version: '1.0.0', datasource: 'users', params: {}, cursor: 'page-2' });
    expect(await within(grid).findByText('Lee Gu')).toBeInTheDocument();
    void user;
  });

  it('bulk actions produce ?playbook=&items= with one rendered inputs object per selected row', async () => {
    const user = userEvent.setup();
    const { search } = renderAt('/p/test.users');
    const grid = await screen.findByRole('grid', { name: 'People' });
    await user.click(await within(grid).findByRole('checkbox', { name: 'Select Adele Vance' }));
    await user.click(within(grid).getByRole('checkbox', { name: 'Select Jordan Miller' }));
    await user.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Block sign-in' }));
    await waitFor(() => expect(search().playbook).toBe('identity.disable-user'));
    expect(decode(search().items)).toEqual([
      { userId: guid(1), $label: 'Adele Vance' },
      { userId: guid(3), $label: 'Jordan Miller' },
    ]);
  });

  it('row actions honour `when` and produce ?playbook=&inputs=', async () => {
    const user = userEvent.setup();
    const { search } = renderAt('/p/test.users');
    const grid = await screen.findByRole('grid', { name: 'People' });
    await user.click(await within(grid).findByRole('button', { name: 'Actions for Diego Siciliani' }));
    expect(await screen.findByRole('menuitem', { name: 'No actions apply to this row' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(grid).getByRole('button', { name: 'Actions for Adele Vance' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Block sign-in' }));
    await waitFor(() => expect(search().playbook).toBe('identity.disable-user'));
    expect(decode(search().inputs)).toEqual({ userId: guid(1) });
  });

  it('clicking a row opens the entity page in the inspector (inspect=page:…&i.id=…), tabs included', async () => {
    const user = userEvent.setup();
    const { search } = renderAt('/p/test.users');
    const grid = await screen.findByRole('grid', { name: 'People' });
    await user.click(await within(grid).findByText('Adele Vance'));
    await waitFor(() => expect(search()).toMatchObject({ inspect: 'page:test.person', 'i.id': guid(1) }));
    const drawer = await screen.findByRole('dialog', { name: 'Adele Vance' });
    expect(await within(drawer).findByText('Sign-in allowed')).toBeInTheDocument();
    // Two actions as buttons, the rest under "More actions".
    expect(await within(drawer).findByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Block sign-in' })).toBeInTheDocument();
    await user.click(within(drawer).getByRole('tab', { name: 'Groups' }));
    await waitFor(() => expect(search().itab).toBe('groups'));
    expect(await within(drawer).findByText('SG-Finance')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('a deep link opens the inspector directly', async () => {
    renderAt(`/p/test.users?inspect=page%3Atest.person&i.id=${guid(1)}`);
    expect(await screen.findByRole('dialog', { name: 'Adele Vance' })).toBeInTheDocument();
  });

  it('saved views: presets apply params; "Save as new view" posts the current state', async () => {
    const user = userEvent.setup();
    const { calls, search } = renderAt('/p/test.users');
    await screen.findByText('Adele Vance');
    await user.click(screen.getByRole('button', { name: /Saved views/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Guests' }));
    await waitFor(() => expect(search()).toMatchObject({ userType: 'Guest', view: 'preset:Guests' }));
    await user.click(screen.getByRole('button', { name: /Saved views: Guests/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save as new view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    await user.type(within(dialog).getByLabelText('Name'), 'My guests');
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/views')?.body).toEqual({ page: 'test.users', name: 'My guests', shared: false, state: { params: { userType: 'Guest' }, table: {} } }));
    await waitFor(() => expect(search().view).toBe('v1'));
  });

  it('renders a report: parameters form, summary, table and the export bar', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const { calls } = renderAt('/p/test.expiry', {
      respond: (url) =>
        url.startsWith('/api/reports/')
          ? new Response('app,days\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="expiry-30d.csv"' } })
          : undefined,
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Credential expiry' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Report parameters' })).toBeInTheDocument();
    expect(await screen.findByText('Example HR Sync')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Export report/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/reports/test.expiry/export')).toBe(true));
    expect(calls.find((c) => c.url === '/api/reports/test.expiry/export')!.body).toMatchObject({ format: 'csv', params: {}, version: '1.0.0' });
    expect(await screen.findByText('Exported expiry-30d.csv')).toBeInTheDocument();
  });

  it('a page whose licence is missing explains it and loads no data (live tenant)', async () => {
    const { calls } = renderAt('/p/test.devices', {
      session: me({ dataMode: 'live' }),
      caps: { features: { intune: { available: false, label: 'Microsoft Intune', sku: 'Microsoft Intune Plan 1 (INTUNE_A)' } }, roles: { active: [], eligible: [] } },
    });
    expect(await screen.findByRole('heading', { name: 'Microsoft Intune isn’t licensed in this tenant' })).toBeInTheDocument();
    expect(screen.getByText('Microsoft Intune Plan 1 (INTUNE_A)')).toBeInTheDocument();
    expect(executeMany(calls)).toHaveLength(0);
    expect(await axeViolations()).toEqual([]);
  });

  it('mock mode keeps fixture data under a "Preview with sample data" banner', async () => {
    const { calls } = renderAt('/p/test.devices', {
      caps: { features: { intune: { available: false, label: 'Microsoft Intune' } }, roles: { active: [], eligible: [] } },
    });
    expect(await screen.findByRole('note', { name: 'Preview with sample data' })).toBeInTheDocument();
    await waitFor(() => expect(executeMany(calls)).toHaveLength(1));
  });

  it('dashboards evaluate templated markdown and say when they refresh', async () => {
    renderAt('/p/test.health');
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeInTheDocument();
    // Re-evaluated once the datasource arrives (the first render has no data yet).
    await waitFor(() => expect(screen.getByText(/Services that need attention:/)).toHaveTextContent('Services that need attention: 1'));
    expect(screen.getByText(/Services that need attention:/).querySelector('strong')).toHaveTextContent('1');
    expect(await screen.findByText(/every 60 s/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Service health' })).toHaveTextContent('Degraded');
  });

  it('an unknown key says so and offers the palette', async () => {
    renderAt('/p/test.missing');
    expect(await screen.findByRole('heading', { level: 1, name: 'There’s no page at this address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open the command palette/ })).toBeInTheDocument();
  });

  it('the command palette searches the directory (debounced) and groups results by type', async () => {
    const user = userEvent.setup();
    const { calls, router } = renderAt('/p/test.users');
    await screen.findByRole('heading', { level: 1, name: 'People' });
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'adele');
    const group = await within(palette).findByRole('group', { name: 'Users' }, { timeout: 2000 });
    expect(calls.filter((c) => c.url.startsWith('/api/search')).map((c) => c.url)).toEqual(['/api/search?q=adele']);
    await user.click(within(group).getByRole('option', { name: /Adele Vance/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/test.person'));
  });
});
