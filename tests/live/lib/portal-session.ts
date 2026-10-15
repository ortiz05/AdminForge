import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { signInWithEntra } from './entra-login';

export interface PortalSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  base: string;
  /** Calls the API with the session cookie (and CSRF for non-GET). */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
  close(): Promise<void>;
}

/**
 * Signs the validation user into a running AdminForge instance through the real Entra flow.
 * `apiOrigin` lets tests talk to the API directly while the browser uses PUBLIC_BASE_URL
 * (requests to PUBLIC_BASE_URL are forwarded to the API when no web server is running).
 */
export async function openPortalSession(opts: { apiOrigin?: string; forwardToApi?: boolean } = {}): Promise<PortalSession> {
  const env = loadEnv();
  const base = env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
  // Cookies are host-scoped (ports ignored): talk to the API on the same host name as PUBLIC_BASE_URL.
  const apiOrigin = opts.apiOrigin ?? `${new URL(base).protocol}//${new URL(base).hostname}:${env.API_PORT ?? 3001}`;
  const creds = { upn: env.AF_TEST_USER_UPN!, password: env.AF_TEST_USER_PASSWORD!, totpSecret: env.AF_TEST_USER_TOTP_SECRET };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  if (opts.forwardToApi) {
    await context.route(`${base}/**`, async (route) => {
      const url = route.request().url();
      if (/\/(auth|api)\//.test(url)) return route.continue({ url: url.replace(base, apiOrigin) });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>AdminForge</title><p>spa placeholder</p>' });
    });
  }
  const page = await context.newPage();
  await page.goto(`${base}/auth/login?returnTo=%2F`);
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => u.toString().startsWith(base), { timeout: 30_000 });

  let csrf: string | undefined;
  const api = async <T>(method: string, path: string, body?: unknown) => {
    if (!csrf && method !== 'GET') csrf = ((await (await context.request.get(`${apiOrigin}/api/me`)).json()) as { csrf: string }).csrf;
    const res = await context.request.fetch(`${apiOrigin}${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'x-adminforge-csrf': csrf!, 'content-type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status(), json: (text ? JSON.parse(text) : undefined) as T };
  };
  return { browser, context, page, base, api, close: () => browser.close() };
}

export async function armWriteAccess(s: PortalSession, minutes = 15, reason = 'Automated live validation'): Promise<void> {
  const env = loadEnv();
  const { status, json } = await s.api<{ redirect: string }>('POST', '/auth/arm', { minutes, reason });
  if (status !== 200) throw new Error(`Arm request failed: ${status} ${JSON.stringify(json)}`);
  await s.page.goto(json.redirect);
  await signInWithEntra(s.page, { upn: env.AF_TEST_USER_UPN!, password: env.AF_TEST_USER_PASSWORD!, totpSecret: env.AF_TEST_USER_TOTP_SECRET });
  await s.page.waitForURL((u) => u.toString().startsWith(s.base), { timeout: 30_000 });
}
