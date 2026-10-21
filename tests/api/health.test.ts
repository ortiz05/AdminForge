import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from '@adminforge/api/src/db/client';
import { ApiErrorBody } from '@adminforge/schemas';
import { makeApp, mockConfig } from './helpers';

describe('health, headers, errors', () => {
  it('GET /healthz → ok, CSP, no-store, correlation id', async () => {
    const { app } = await makeApp(mockConfig());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('never takes the correlation id (the audit Reference) from the browser', async () => {
    const { app } = await makeApp(mockConfig());
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const chosen = (await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-correlation-id': id } }))
      .headers['x-correlation-id'];
    expect(chosen).not.toBe(id);
    expect(chosen).toMatch(/^[0-9a-f-]{36}$/);
    const junk = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'evil\nheader' },
    });
    expect(junk.headers['x-correlation-id']).not.toBe('evil\nheader');
    await app.close();
  });

  it('GET /readyz reports the store and fails with 503 when the DB is down', async () => {
    const mem = await makeApp(mockConfig());
    expect((await mem.app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({
      status: 'ok',
      // The audit chain's state is informational (S-10): unkeyed never makes the answer degraded.
      checks: { db: 'memory', auditChain: 'unkeyed' },
    });
    await mem.app.close();

    const down = {
      ping: async () => Promise.reject(new Error('ECONNREFUSED')),
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
    const bad = await makeApp(mockConfig(), { database: down });
    const res = await bad.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('not_ready');
    await bad.app.close();
  });

  it('unknown routes and malformed bodies produce ApiErrorBody', async () => {
    const { app } = await makeApp(mockConfig());
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorBody.parse(missing.json()).error).toMatchObject({ code: 'not_found' });
    expect(missing.headers['cache-control']).toBe('no-store');

    const login = await app.inject({ method: 'GET', url: '/auth/login' });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const malformed = await app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(ApiErrorBody.parse(malformed.json()).error.correlationId).toBe(
      malformed.headers['x-correlation-id'],
    );

    // An empty body with a JSON content type is "no body", not an error (bodiless POSTs from fetch wrappers).
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    const disarm = await app.inject({
      method: 'POST',
      url: '/auth/disarm',
      headers: { cookie, 'content-type': 'application/json', 'x-adminforge-csrf': me.json().csrf },
      payload: '',
    });
    expect(disarm.statusCode).toBe(200);
    const poisoned = await app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'content-type': 'application/json', 'x-adminforge-csrf': me.json().csrf },
      payload: '{"__proto__":{"admin":true}}',
    });
    expect(poisoned.statusCode).toBe(400);
    await app.close();
  });

  it('rate limits with an ApiErrorBody (health checks exempt)', async () => {
    const { app } = await makeApp(mockConfig({ RATE_LIMIT_PER_MINUTE: '3' }));
    for (let i = 0; i < 3; i++)
      expect((await app.inject({ method: 'GET', url: '/api/nav' })).statusCode).toBe(401);
    const limited = await app.inject({ method: 'GET', url: '/api/nav' });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorBody.parse(limited.json()).error.code).toBe('rate_limited');
    for (let i = 0; i < 5; i++)
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  describe('static SPA (when the web build exists)', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'af-web-'));
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(
        path.join(dir, 'index.html'),
        '<!doctype html><title>AdminForge</title><div id="root"></div>',
      );
      writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('serves assets immutably, falls back to index.html for client routes, keeps /api JSON', async () => {
      const { app } = await makeApp(mockConfig({ WEB_DIST_DIR: dir }));
      const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

      for (const url of ['/', '/p/identity.users', '/signed-out']) {
        const page = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('<div id="root">');
        expect(page.headers['cache-control']).toBe('no-cache');
        expect(page.headers['content-security-policy']).toContain("default-src 'self'");
      }
      const api = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(api.statusCode).toBe(404);
      expect(api.json().error.code).toBe('not_found');
      const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.json().error.code).toBe('not_found');
      await app.close();
    });
  });
});
