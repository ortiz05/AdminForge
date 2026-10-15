import '../ensure-route-tree';
import { render } from '@testing-library/react';
import type { MeResponse } from '@adminforge/schemas';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { overview } from '../../../e2e/fixtures/overview';
import { me, NAV } from '../../../e2e/fixtures/session';
import type { MockHandler } from '../../../e2e/support/mock-api';
import { automationApi, type AutomationOptions } from '../../../e2e/support/mock-automation';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export interface Call {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

/**
 * The real app (router, shell, lazy routes) against the same stateful automation mock the Playwright specs use,
 * answered through a stubbed fetch. jsdom has no EventSource, so live views fall back to polling.
 */
export function renderApp({
  path = '/',
  session = me(),
  handlers = [],
  automation,
}: { path?: string; session?: MeResponse; handlers?: MockHandler[]; automation?: AutomationOptions } = {}) {
  const auto = automationApi(automation);
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
      const csrf = (init?.headers as Record<string, string> | undefined)?.['X-AdminForge-CSRF'] ?? null;
      calls.push({ method, url: `${url.pathname}${url.search}`, body, csrf });
      for (const h of [...handlers, auto.handler]) {
        const r = h({ method, path: url.pathname, url, body, csrf });
        if (r)
          return r.text !== undefined
            ? new Response(r.text, { status: r.status ?? 200 })
            : json(r.body ?? {}, r.status ?? 200);
      }
      if (url.pathname === '/api/me') return json(session);
      if (url.pathname === '/api/nav') return json(NAV);
      if (url.pathname === '/api/overview') return json(overview());
      if (url.pathname === '/api/runs') return json({ items: [] });
      return json({ error: { code: 'not_found', message: `No mock for ${method} ${url.pathname}` } }, 404);
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  const view = render(<App router={router} queryClient={queryClient} />);
  return { ...view, calls, router, state: auto.state, queryClient };
}
