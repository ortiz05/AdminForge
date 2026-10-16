import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
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
 * when the context has a baseURL). The CSRF token is read from `/api/me` before the first non-GET call.
 */
export function createApiCall(request: APIRequestContext, origin = ''): ApiCall {
  let csrf: string | undefined;
  return async <T>(method: string, path: string, body?: unknown) => {
    if (!csrf && method !== 'GET')
      csrf = ((await (await request.get(`${origin}/api/me`)).json()) as { csrf: string }).csrf;
    const res = await request.fetch(`${origin}${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'x-adminforge-csrf': csrf!, 'content-type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status(), json: (text ? JSON.parse(text) : undefined) as T };
  };
}

/**
 * Signs the validation user into a running AdminForge instance through the real Entra flow.
 * `apiOrigin` lets tests talk to the API directly while the browser uses PUBLIC_BASE_URL
 * (requests to PUBLIC_BASE_URL are forwarded to the API when no web server is running).
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
  if (opts.forwardToApi) {
    await context.route(`${base}/**`, async (route) => {
      const url = route.request().url();
      if (/\/(auth|api)\//.test(url)) return route.continue({ url: url.replace(base, apiOrigin) });
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>AdminForge</title><p>spa placeholder</p>',
      });
    });
  }
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
    close: () => browser.close(),
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
