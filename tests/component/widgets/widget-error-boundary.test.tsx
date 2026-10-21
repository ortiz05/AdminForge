import '../web/ensure-route-tree';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import {
  WIDGETS,
  createWidgetRuntime,
  type KpiConfig,
  type ListConfig,
  type WidgetRuntime,
} from '@adminforge/widgets';
import { me, NAV } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { ready } from './helpers';

// One block that can't be displayed (hostile or malformed tenant data, a widget bug) costs that block only: it says
// so with a reference and Try again, and the rest of the /p/<key> page keeps working (S-05).
const List = WIDGETS.list!.component;
const Kpi = WIDGETS.kpi!.component;

const listConfig = (title: string, extra: Record<string, unknown> = {}) =>
  WIDGETS.list!.schema.parse({
    widget: 'list',
    title,
    data: 'items.value',
    primary: 'name',
    ...extra,
  }) as ListConfig;

/** A row whose `name` throws when read: stands in for any value a widget can't render. */
function explodingRow(state = { explode: true }) {
  return {
    id: 'r1',
    get name(): string {
      if (state.explode) throw new Error('boom: internal detail at Widget.tsx:79');
      return 'Recovered row';
    },
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React and the boundary log the caught error; keep the test output readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectDesignedError(region: HTMLElement, label: string) {
  const alert = within(region).getByRole('alert');
  expect(alert).toHaveTextContent(`${label} couldn’t be shown`);
  expect(alert).toHaveTextContent('The rest of the page still works, and nothing was changed.');
  expect(alert).toHaveTextContent('give a portal administrator the reference');
  expect(within(alert).getByText('Reference')).toBeInTheDocument();
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  // Never the error's own text or a stack trace.
  expect(region).not.toHaveTextContent('boom');
  expect(region).not.toHaveTextContent('Widget.tsx');
  return alert;
}

describe('widget error boundary', () => {
  it('a widget that throws while rendering shows a designed error in its own block; the next block renders', async () => {
    const runtime = createWidgetRuntime();
    const { container } = render(
      <div>
        <List
          config={listConfig('Risky apps')}
          data={ready([explodingRow()])}
          runtime={runtime}
          instanceId="w0"
        />
        <List
          config={listConfig('Healthy apps')}
          data={ready([{ id: 'ok', name: 'Example Portal' }])}
          runtime={runtime}
          instanceId="w1"
        />
      </div>,
    );
    const failed = screen.getByRole('region', { name: 'Risky apps' });
    expectDesignedError(failed, 'Risky apps');
    expect(
      within(screen.getByRole('region', { name: 'Healthy apps' })).getByText('Example Portal'),
    ).toBeVisible();
    // The reference shown is the one logged with the error, so a report can be matched up.
    const copy = within(failed).getByRole('button', { name: /^Copy Reference / });
    const reference = copy.getAttribute('aria-label')!.replace('Copy Reference ', '');
    expect(reference).toMatch(/^[0-9a-f-]{16,}$/);
    const logged = consoleError.mock.calls.find((c) => String(c[0]).startsWith('AdminForge widget error'));
    expect(String(logged?.[0])).toBe(`AdminForge widget error (reference ${reference})`);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('a crash inside the panel keeps the panel and its title', async () => {
    const runtime: WidgetRuntime = createWidgetRuntime({
      Link: () => {
        throw new Error('boom: link');
      },
    });
    render(
      <List
        config={listConfig('Open incidents', { href: '/p/security.incident?id=${ row.id }' })}
        data={ready([{ id: 'inc-1', name: 'Impossible travel' }])}
        runtime={runtime}
        instanceId="w0"
      />,
    );
    const panel = screen.getByRole('region', { name: 'Open incidents' });
    expect(within(panel).getByRole('heading', { name: 'Open incidents' })).toBeInTheDocument();
    // The row link renders once its template resolves; until then the row is plain text.
    await within(panel).findByRole('alert');
    expectDesignedError(panel, 'Open incidents');
  });

  it('Try again renders the block again', async () => {
    const user = userEvent.setup();
    const state = { explode: true };
    render(
      <List
        config={listConfig('Risky apps')}
        data={ready([explodingRow(state)])}
        runtime={createWidgetRuntime()}
        instanceId="w0"
      />,
    );
    const alert = expectDesignedError(screen.getByRole('region', { name: 'Risky apps' }), 'Risky apps');
    state.explode = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered row')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('new data clears the error by itself', () => {
    const runtime = createWidgetRuntime();
    const config = listConfig('Risky apps');
    const { rerender } = render(
      <List config={config} data={ready([explodingRow()])} runtime={runtime} instanceId="w0" />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(
      <List
        config={config}
        data={ready([{ id: 'n', name: 'Fresh row' }])}
        runtime={runtime}
        instanceId="w0"
      />,
    );
    expect(screen.getByText('Fresh row')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a KPI cell that fails stays a cell (no panel of its own) and names the figure', () => {
    const runtime = createWidgetRuntime({
      resolve: () => {
        throw new Error('boom: resolve');
      },
    });
    const config = WIDGETS.kpi!.schema.parse({
      widget: 'kpi',
      label: 'Guests',
      data: 'counts.guests',
      delta: 'counts.delta',
    }) as KpiConfig;
    const { container } = render(
      <Kpi config={config} data={ready(12)} runtime={runtime} instanceId="k0" variant="cell" />,
    );
    expectDesignedError(container as HTMLElement, 'Guests');
    expect(container.querySelector('section')).toBeNull();
  });

  it('a list with a hostile character reference in one row still renders every row', () => {
    render(
      <List
        config={listConfig('Applications')}
        data={ready([
          { id: 'a', name: '<b>Example HR Sync &#1114112;</b>' },
          { id: 'b', name: 'Example Portal' },
        ])}
        runtime={createWidgetRuntime()}
        instanceId="w0"
      />,
    );
    const list = screen.getByRole('list', { name: 'Applications' });
    expect(within(list).getByText('Example HR Sync &#1114112;')).toBeVisible();
    expect(within(list).getByText('Example Portal')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// The page renderer looks widgets up in the registry, so every block of a /p/<key> page is guarded.
describe('a /p/<key> page with one block that fails', () => {
  const PAGE = {
    kind: 'dashboard',
    id: 'test.crash',
    version: '1.0.0',
    sha256: 'c',
    title: 'Application health',
    owner: 'test',
    template: 'dashboard',
    datasources: {
      apps: { source: 'graph', request: { method: 'GET', path: '/applications' } },
    },
    layout: [
      { widget: 'list', title: 'Risky apps', data: 'apps.value', primary: 'displayName' },
      { widget: 'markdown', title: 'About', text: 'Review risky apps **weekly**.' },
    ],
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });

  it('keeps the page, its header and the other blocks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url, 'http://localhost');
        if (u.pathname === '/api/me') return json(me());
        if (u.pathname === '/api/nav') return json(NAV);
        if (u.pathname === '/api/definitions/dashboard/test.crash') return json(PAGE);
        if (u.pathname.startsWith('/api/definitions/'))
          return json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
        if (u.pathname === '/api/datasources/execute-many')
          return json({
            results: {
              apps: {
                data: { value: [{ id: 'a1', displayName: '<b>Example &#65;pp</b>' }] },
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
    // Any unexpected throw while the list renders (here: decoding the reference) stands in for a widget crash.
    const fromCodePoint = String.fromCodePoint;
    vi.spyOn(String, 'fromCodePoint').mockImplementation((...points: number[]) => {
      if (points[0] === 65) throw new RangeError('boom: decoder');
      return fromCodePoint(...points);
    });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(
      <App
        router={createAppRouter(queryClient, { initialPath: '/p/test.crash' })}
        queryClient={queryClient}
      />,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Application health' })).toBeInTheDocument();
    await screen.findByText('Risky apps couldn’t be shown');
    expectDesignedError(screen.getByRole('region', { name: 'Risky apps' }), 'Risky apps');
    expect(screen.getByRole('region', { name: 'About' })).toHaveTextContent('Review risky apps weekly.');
    expect(screen.queryByText('This page hit a problem')).toBeNull();
  });
});
