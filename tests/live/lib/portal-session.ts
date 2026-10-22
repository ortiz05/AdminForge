import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createServer, request as forward, type Server } from 'node:http';
import { loadEnv } from '@adminforge/config';
import { signInWithEntra, testUserCredentials } from './entra-login';
import { maskError } from './mask';

/**
 * A signed-in AdminForge session for live scripts: the validation user signs in through the real Entra flow in a
 * headless Chrome (`openPortalSession`), then the script calls the API with the session cookie (`session.api`),
 * optionally after arming write access (`armWriteAccess`, a step-up sign-in to the Write app).
 *
 * Inputs: the env file plus `<env>.admin.env` (PUBLIC_BASE_URL, API_PORT, AF_TEST_USER_UPN / _PASSWORD /
 * _TOTP_SECRET). Outputs: a `PortalSession`; nothing is printed. Safety: the validation user only (credentials from
 * `testUserCredentials`), and errors carry status codes and masked error codes, never response bodies.
 * Used by tests/live/scripts/{check-page-datasources,check-placeholders,run-playbook,verify-api-live}.ts;
 * `createApiCall` is also what e2e/portal.live.spec.ts calls the API with.
 */

/** Calls the AdminForge API as the session: JSON in and out, CSRF header on every non-GET request. */
export type ApiCall = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: T }>;

export interface PortalSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  base: string;
  /** Calls the API with the session cookie (and CSRF for non-GET). */
  api: ApiCall;
  close(): Promise<void>;
}

/**
 * An `ApiCall` over a Playwright request context that holds the session cookie. `origin` prefixes every path (''
 * when the context has a baseURL). The CSRF token is read from `/api/me` before the first non-GET call, and again
 * (one retry) when the API says it's stale — arming gives the session a new id and CSRF token, as the SPA handles.
 */
export function createApiCall(request: APIRequestContext, origin = ''): ApiCall {
  let csrf: string | undefined;
  const readCsrf = async () =>
    ((await (await request.get(`${origin}/api/me`)).json()) as { csrf: string }).csrf;
  const call = async <T>(method: string, path: string, body?: unknown, retried = false) => {
    if (!csrf && method !== 'GET') csrf = await readCsrf();
    const res = await request.fetch(`${origin}${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'x-adminforge-csrf': csrf!, 'content-type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : undefined) as T;
    if (res.status() === 403 && !retried && (json as { error?: { code?: string } })?.error?.code === 'csrf') {
      csrf = await readCsrf();
      return call<T>(method, path, body, true);
    }
    return { status: res.status(), json };
  };
  return (method, path, body) => call(method, path, body);
}

/**
 * Stands in for the web dev server on PUBLIC_BASE_URL: `/auth` and `/api` go to the API (as Vite's proxy does), anything
 * else gets a placeholder page. A real server, not `context.route`: Chrome leaves the sign-in binding cookie off a
 * request rerouted to another port, and Playwright doesn't route the redirect a fulfilled response leads to.
 */
async function standInWebServer(base: string, apiOrigin: string): Promise<Server> {
  const api = new URL(apiOrigin);
  const server = createServer((req, res) => {
    if (!/^\/(auth|api)\//.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>AdminForge</title><p>spa placeholder</p>');
      return;
    }
    const upstream = forward(
      { hostname: api.hostname, port: api.port, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  const { hostname, port } = new URL(base);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port || 80), hostname, resolve);
  });
  return server;
}

/**
 * Signs the validation user into a running AdminForge instance through the real Entra flow.
 * `apiOrigin` lets tests talk to the API directly while the browser uses PUBLIC_BASE_URL
 * (`forwardToApi`: a stand-in web server forwards PUBLIC_BASE_URL's `/auth` and `/api` when no web server is running).
 */
export async function openPortalSession(
  opts: { apiOrigin?: string; forwardToApi?: boolean } = {},
): Promise<PortalSession> {
  const env = loadEnv(process.env, { admin: true });
  const base = env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
  // Cookies are host-scoped (ports ignored): talk to the API on the same host name as PUBLIC_BASE_URL.
  const apiOrigin =
    opts.apiOrigin ?? `${new URL(base).protocol}//${new URL(base).hostname}:${env.API_PORT ?? 3001}`;
  const creds = testUserCredentials(env);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const stand = opts.forwardToApi ? await standInWebServer(base, apiOrigin) : null;
  const page = await context.newPage();
  await page.goto(`${base}/auth/login?returnTo=%2F`);
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => u.toString().startsWith(base), { timeout: 30_000 });
  return {
    browser,
    context,
    page,
    base,
    api: createApiCall(context.request, apiOrigin),
    close: async () => {
      await browser.close();
      await new Promise((resolve) => (stand ? stand.close(resolve) : resolve(undefined)));
    },
  };
}

/** Arms write access for `minutes` (step-up sign-in to the Write app as the validation user). */
export async function armWriteAccess(
  s: PortalSession,
  minutes = 15,
  reason = 'Automated live validation',
): Promise<void> {
  const env = loadEnv(process.env, { admin: true });
  const { status, json } = await s.api<{ redirect: string; error?: unknown }>('POST', '/auth/arm', {
    minutes,
    reason,
  });
  if (status !== 200) throw new Error(`Arm request failed: ${status} ${maskError(json?.error)}`);
  await s.page.goto(json.redirect);
  await signInWithEntra(s.page, testUserCredentials(env));
  await s.page.waitForURL((u) => u.toString().startsWith(s.base), { timeout: 30_000 });
}
