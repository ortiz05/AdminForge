// Live: the AdminForge API end to end as the validation user — SSO sign-in, /api/me, overview, arm (step-up sign-in to
// the Write app), disarm, logout. Needs only the API running: the browser's /auth and /api requests are forwarded to it.
//
// Usage (repository root; the validation user enabled — see tests/live/README.md):
//   pnpm exec tsx tests/live/scripts/verify-api-live.ts [failure-screenshot.png]
// Inputs: the env file and <env>.admin.env (PUBLIC_BASE_URL, API_PORT, the validation user's credentials).
// Output: HTTP statuses, the number of portal roles, modes, overview counts and section error codes — no names, ids
//   or messages unmasked. On failure: a masked error, the last page (masked URL) and a screenshot, by default
//   `<AF_LIVE_OUT>/verify-api-live-failure.png` (lib/output.ts); exit code 1.
// Safety: arms write access but changes nothing; disarms and signs out.
import { maskError, maskUrl } from '../lib/mask';
import { liveOutFile } from '../lib/output';
import { armWriteAccess, openPortalSession } from '../lib/portal-session';

const s = await openPortalSession({ forwardToApi: true });
try {
  const me = await s.api<{ roles?: string[]; mode: string; authMode: string }>('GET', '/api/me');
  console.log('me:', me.status, {
    roles: me.json?.roles?.length ?? 0,
    mode: me.json?.mode,
    authMode: me.json?.authMode,
  });
  const ov = await s.api<{
    counts?: unknown;
    skus?: unknown[];
    health?: { error?: { code: string } };
    errors?: Record<string, { code?: string }>;
  }>('GET', '/api/overview');
  const o = ov.json ?? {};
  console.log('overview:', ov.status, {
    counts: o.counts,
    skus: o.skus?.length,
    health: o.health?.error ? o.health.error.code : 'ok',
    errors: Object.fromEntries(Object.entries(o.errors ?? {}).map(([k, e]) => [k, e.code ?? 'error'])),
  });
  await armWriteAccess(s, 15);
  const armed = await s.api<{ mode: string; armedUntil: string }>('GET', '/api/me');
  console.log('after arm:', armed.json.mode, Boolean(armed.json.armedUntil));
  const dis = await s.api('POST', '/auth/disarm');
  console.log('disarm:', dis.status);
  const out = await s.api<{ redirect: string }>('POST', '/auth/logout');
  console.log('logout:', out.status, Boolean(out.json?.redirect));
} catch (e) {
  await s.page.screenshot({
    path: liveOutFile(process.argv[2], 'verify-api-live-failure.png'),
  });
  console.error('FAILED:', maskError(e), '| url:', maskUrl(s.page.url()));
  process.exitCode = 1;
} finally {
  await s.close();
}
