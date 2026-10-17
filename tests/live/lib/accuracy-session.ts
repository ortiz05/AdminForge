import { chromium } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { signInWithEntra, testUserCredentials } from './entra-login';
import { createApiCall, type PortalSession } from './portal-session';

/**
 * A signed-in session for scripts that talk to a deployed AdminForge through its public URL — the host services behind
 * Caddy (`PUBLIC_BASE_URL=https://<lan-address>:8443`) — rather than a dev API on API_PORT: the API calls go to the same
 * origin the browser signed in on. `AF_LIVE_INSECURE_TLS=1` accepts a private CA (Caddy `tls internal`), as in the live
 * suite (tests/live/e2e/playwright.config.ts).
 *
 * Inputs: the env file plus `<env>.admin.env` (PUBLIC_BASE_URL, AF_TEST_USER_*), `process.env` overriding both.
 * Outputs: a `PortalSession`; nothing is printed. Safety: the validation user only. Used by scripts/check-accuracy.ts.
 */
export async function openPublicSession(): Promise<PortalSession> {
  const env = loadEnv(process.env, { admin: true });
  const base = (env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.AF_LIVE_INSECURE_TLS === '1' });
  const page = await context.newPage();
  await page.goto(`${base}/auth/login?returnTo=%2F`);
  await signInWithEntra(page, testUserCredentials(env));
  await page.waitForURL((u) => u.toString().startsWith(base), { timeout: 30_000 });
  return {
    browser,
    context,
    page,
    base,
    api: createApiCall(context.request, base),
    close: () => browser.close(),
  };
}
