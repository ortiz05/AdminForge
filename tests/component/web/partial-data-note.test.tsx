import './ensure-route-tree';
import { render, screen } from '@testing-library/react';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me, NAV } from '../../support/web/fixtures/session';
import { DASHBOARD, RESULTS } from './renderer-fixtures';

// A datasource that read only part of what Microsoft has (`paging: all` stopped at its item cap, a `$batch` collection's
// first page) comes back `truncated`; the widget says so instead of letting a cut list or count read as complete.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KPI_DASHBOARD = {
  ...DASHBOARD,
  id: 'test.partial',
  layout: [
    {
      widget: 'kpi',
      id: 'degraded',
      data: 'health.value',
      label: 'Services',
      format: 'number',
      field: 'length',
    },
    ...DASHBOARD.layout,
  ],
};

function serve(def: object, truncated: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/me') return json(me());
      if (u.pathname === '/api/nav') return json(NAV);
      if (u.pathname === `/api/definitions/dashboard/${(def as { id: string }).id}`) return json(def);
      if (u.pathname.startsWith('/api/definitions/'))
        return json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
      if (u.pathname === '/api/datasources/execute-many')
        return json({
          results: { health: { ...RESULTS.health, ...(truncated ? { truncated: true } : {}) } },
        });
      if (u.pathname === '/api/me/capabilities')
        return json({ features: {}, roles: { active: [], eligible: [] } });
      return json({ ok: true });
    }),
  );
}

function open(id: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: `/p/${id}` });
  render(<App router={router} queryClient={queryClient} />);
}

describe('partial data note', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says the data is partial under a widget whose datasource was cut off', async () => {
    serve(DASHBOARD, true);
    open('test.health');
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      /Partial data: Microsoft has more than this view reads/,
    );
  });

  it('says it once for a strip of key figures', async () => {
    serve(KPI_DASHBOARD, true);
    open('test.partial');
    expect(
      await screen.findByText(/Some figures count only the first items Microsoft returned/),
    ).toBeInTheDocument();
  });

  it('shows nothing when the whole result was read', async () => {
    serve(DASHBOARD, false);
    open('test.health');
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
