/**
 * Renders the whole app at a path with a stubbed `fetch`: `/api/me`, `/api/nav`, definitions from `definitions`
 * (`<kind>/<key>` → body), datasource results from `results`, capabilities, views and probes. `respond` answers
 * anything first. Used by the renderer's component tests that need the shell (header, actions, write access).
 */
import './ensure-route-tree';
import { render } from '@testing-library/react';
import type { MeResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { me, NAV } from '../../support/web/fixtures/session';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface PageCall {
  method: string;
  url: string;
  body?: unknown;
}

export interface RenderPageOptions {
  definitions?: Record<string, unknown>;
  results?: Record<string, unknown>;
  session?: MeResponse;
  respond?: (url: string, init?: RequestInit) => Response | undefined;
}

export function renderPage(path: string, opts: RenderPageOptions = {}) {
  const { definitions = {}, results = {}, session = me(), respond } = opts;
  const calls: PageCall[] = [];
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
        const hit = definitions[`${def[1]}/${decodeURIComponent(def[2]!)}`];
        return hit
          ? json(hit)
          : json({ error: { code: 'definition_not_found', message: 'No such definition.' } }, 404);
      }
      if (u.pathname === '/api/datasources/execute-many') {
        const names = (body as { datasources: string[] }).datasources;
        return json({
          results: Object.fromEntries(
            names.map((n) => [n, results[n] ?? { error: { code: 'nope', message: `No result for ${n}` } }]),
          ),
        });
      }
      if (u.pathname === '/api/me/capabilities')
        return json({ features: {}, roles: { active: [], eligible: [] } });
      if (u.pathname === '/api/views') return json({ items: [] });
      if (u.pathname === '/api/probes') return json({ items: [] });
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  const view = render(<App router={router} queryClient={queryClient} />);
  return { calls, router, view };
}
