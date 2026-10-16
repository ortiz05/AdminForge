import './ensure-route-tree';
import { render, screen, waitFor } from '@testing-library/react';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { ApiRequestError } from '@adminforge/web/src/lib/api';
import { isStaleDefinition } from '@adminforge/web/src/renderer/api';
import { me, NAV } from '../../support/web/fixtures/session';
import { DASHBOARD, RESULTS } from './renderer-fixtures';

// The server only answers for the current version of a page (M2): when the page was updated since the tab loaded it,
// the renderer reloads the definition and asks again for the new version.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('page renderer and superseded versions', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a 409 version_superseded reloads the definition, then loads the data for the new version', async () => {
    let current = '1.0.0';
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url, 'http://localhost');
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (u.pathname === '/api/me') return json(me());
        if (u.pathname === '/api/nav') return json(NAV);
        if (u.pathname === '/api/definitions/dashboard/test.health') {
          const def = { ...DASHBOARD, version: current };
          // Published while the tab was loading.
          current = '1.1.0';
          return json(def);
        }
        if (u.pathname.startsWith('/api/definitions/'))
          return json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
        if (u.pathname === '/api/datasources/execute-many') {
          sent.push(body.version);
          if (body.version !== '1.1.0')
            return json(
              {
                error: {
                  code: 'version_superseded',
                  message: 'Health was updated (version 1.1.0) since this page loaded.',
                  hint: 'Reload the page to use the current version.',
                },
              },
              409,
            );
          return json({ results: { health: RESULTS.health } });
        }
        if (u.pathname === '/api/me/capabilities')
          return json({ features: {}, roles: { active: [], eligible: [] } });
        return json({ ok: true });
      }),
    );
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const router = createAppRouter(queryClient, { initialPath: '/p/test.health' });
    render(<App router={router} queryClient={queryClient} />);
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    await waitFor(() => expect(sent).toEqual(['1.0.0', '1.1.0']));
  });

  it('isStaleDefinition: only the version and retirement 409s', () => {
    expect(isStaleDefinition(new ApiRequestError(409, 'version_superseded', 'x'))).toBe(true);
    expect(isStaleDefinition(new ApiRequestError(409, 'definition_retired', 'x'))).toBe(true);
    expect(isStaleDefinition(new ApiRequestError(409, 'preview_stale', 'x'))).toBe(false);
    expect(isStaleDefinition(new ApiRequestError(403, 'version_superseded', 'x'))).toBe(false);
    expect(isStaleDefinition(new Error('x'))).toBe(false);
  });
});
