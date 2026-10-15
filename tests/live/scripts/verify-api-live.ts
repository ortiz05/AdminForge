// Live validation of the AdminForge API against the configured tenant (prints no identifiers or secrets).
import { armWriteAccess, openPortalSession } from '../lib/portal-session';

const s = await openPortalSession({ forwardToApi: true });
try {
  const me = await s.api<{ user: { name: string }; roles: string[]; mode: string; authMode: string }>(
    'GET',
    '/api/me',
  );
  console.log('me:', me.status, {
    name: me.json.user?.name,
    roles: me.json.roles,
    mode: me.json.mode,
    authMode: me.json.authMode,
  });
  const ov = await s.api<Record<string, unknown>>('GET', '/api/overview');
  const o = ov.json as { counts?: unknown; skus?: unknown[]; health?: unknown; errors?: unknown };
  console.log('overview:', ov.status, {
    counts: o.counts,
    skus: o.skus?.length,
    health:
      o.health && 'error' in (o.health as object)
        ? (o.health as { error: { code: string } }).error.code
        : 'ok',
    errors: o.errors,
  });
  await armWriteAccess(s, 15);
  const armed = await s.api<{ mode: string; armedUntil: string }>('GET', '/api/me');
  console.log('after arm:', armed.json.mode, Boolean(armed.json.armedUntil));
  const dis = await s.api('POST', '/auth/disarm');
  console.log('disarm:', dis.status);
  const out = await s.api<{ redirect: string }>('POST', '/auth/logout');
  console.log('logout:', out.status, Boolean(out.json?.redirect));
} catch (e) {
  await s.page.screenshot({ path: process.argv[2] ?? '/tmp/af-live-failure.png' });
  console.error('FAILED:', (e as Error).message, '| url:', s.page.url().replace(/[?#].*/, ''));
  process.exitCode = 1;
} finally {
  await s.close();
}
