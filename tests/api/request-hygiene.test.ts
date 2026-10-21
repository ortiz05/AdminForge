import { loggerOptions, PERMISSIONS_POLICY, redactUrl } from '@adminforge/api/src/app';
import { loadConfig } from '@adminforge/api/src/config';
import type { Database } from '@adminforge/api/src/db/client';
import { makeApp, mockConfig, mockLogin } from './helpers';

// APP-09: request logs keep /api parameter names only (searches and audit filters name people). APP-10: a
// Permissions-Policy on every response, and a public /readyz that names no configuration keys or internals.
describe('request URLs in logs (APP-09)', () => {
  it.each([
    ['/api/search?q=avery%40example.com&type=users', '/api/search?q=[redacted]&type=[redacted]'],
    ['/api/audit?actor=alex%40example.com&from=2026-10-01', '/api/audit?actor=[redacted]&from=[redacted]'],
    ['/api/search?alex.doe%40example.com', '/api/search?[redacted]'],
    ['/api/search?q=', '/api/search?q=[redacted]'],
    ['/api/runs', '/api/runs'],
    ['/api?x=1', '/api?x=[redacted]'],
  ])('%s → %s', (url, logged) => {
    expect(redactUrl(url)).toBe(logged);
  });

  it('keeps redacting secrets (and Entra’s error text) on /auth URLs, and leaves the rest readable', () => {
    expect(
      redactUrl('/auth/callback?code=abc&state=def&error=access_denied&error_description=Call%20me'),
    ).toBe(
      '/auth/callback?code=[redacted]&state=[redacted]&error=access_denied&error_description=[redacted]',
    );
    expect(redactUrl('/auth/login?returnTo=%2Fp%2Fidentity.users')).toBe(
      '/auth/login?returnTo=%2Fp%2Fidentity.users',
    );
    expect(redactUrl('/assets/app.js')).toBe('/assets/app.js');
  });

  it('is what the request serializer logs', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
    });
    const opts = loggerOptions(cfg) as {
      serializers: { req: (r: { method: string; url: string; ip?: string }) => { url: string } };
    };
    expect(opts.serializers.req({ method: 'GET', url: '/api/search?q=avery' }).url).toBe(
      '/api/search?q=[redacted]',
    );
  });
});

describe('response headers and public readiness (APP-10)', () => {
  it('sends a Permissions-Policy on API, health and not-found responses', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    for (const res of [
      await t.app.inject({ method: 'GET', url: '/healthz' }),
      await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } }),
      await t.app.inject({ method: 'GET', url: '/nope.js' }),
    ])
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    await t.app.close();
  });

  it('a failing /readyz names no configuration key or command', async () => {
    const db = {
      ping: async () => {
        throw new Error('ECONNREFUSED');
      },
      db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
      // What building the app reads without querying: the startup file check (`:memory:` has no file to check), the
      // stores' connection handle, the run queue's lease holder (`origin`) and the schedule events' subscription.
      path: ':memory:',
      sqlite: {},
      signals: {
        origin: 'test',
        on: () => () => undefined,
        onResync: () => () => undefined,
        publish: () => undefined,
        prune: () => 0,
        stop: () => undefined,
      },
      close: async () => {},
    } as unknown as Database;
    const t = await makeApp(mockConfig(), { database: db });
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const error = res.json().error;
    expect(error.code).toBe('not_ready');
    expect(error.message).toBe('AdminForge isn’t ready to serve requests.');
    expect(JSON.stringify(res.json())).not.toMatch(/DATABASE_PATH|SQLite|sqlite|pnpm/);
    await t.app.close();
  });
});
