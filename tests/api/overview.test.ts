import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OverviewResponse } from '@adminforge/api/src/routes/overview';
import { ApiErrorBody } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import {
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  json,
  makeApp,
  mockConfig,
  mockLogin,
  orgResponse,
} from './helpers';

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/graph', name), 'utf8'));

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { requests: Array<{ id: string; method: string; url: string; headers?: Record<string, string> }> };
}

/** Entra app whose Graph $batch is answered by `batch`; the sign-in org lookup gets a normal answer. */
async function liveApp(batch: (call: number) => Response) {
  const auth = new FakeAuthClient();
  const calls: Captured[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/$batch')) {
      calls.push({
        url,
        headers: init!.headers as Record<string, string>,
        body: JSON.parse(String(init!.body)),
      });
      return batch(calls.length);
    }
    return orgResponse();
  };
  const t = await makeApp(entraConfig(), { auth, fetch });
  const login = await t.app.inject({ method: 'GET', url: '/auth/login' });
  const state = new URL(login.headers.location as string).searchParams.get('state')!;
  const cb = await t.app.inject({ method: 'GET', url: `/auth/callback?code=c&state=${state}` });
  const cookie = cookieFrom(cb)!;
  return { ...t, auth, calls, cookie };
}

describe('GET /api/overview', () => {
  it('serves the synthetic fixture in DATA_MODE=fixtures', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = OverviewResponse.parse(res.json());
    expect(body).toEqual(fixture('overview.json'));
    expect(body.org.name).toBe('Example Org');
    await t.app.close();
  });

  it('requires a session', async () => {
    const t = await makeApp(mockConfig());
    expect((await t.app.inject({ method: 'GET', url: '/api/overview' })).statusCode).toBe(401);
    await t.app.close();
  });

  it('mock auth with live data is refused with a hint', async () => {
    const t = await makeApp(mockConfig({ DATA_MODE: 'live' }));
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('live_data_unavailable');
    await t.app.close();
  });

  it('live: one $batch with the read token, correlation id, eventual consistency for counts', async () => {
    const t = await liveApp(() => json(fixture('overview-batch.json'), 200, { 'request-id': 'req-batch-1' }));
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    const body = OverviewResponse.parse(res.json());

    expect(t.calls).toHaveLength(1);
    const [call] = t.calls;
    expect(call!.url).toBe('https://graph.microsoft.com/v1.0/$batch');
    expect(call!.headers.Authorization).toBe('Bearer token-read');
    expect(call!.headers['client-request-id']).toBe(res.headers['x-correlation-id']);
    expect(call!.body.requests.map((r) => r.url)).toEqual([
      '/organization?$select=id,displayName,verifiedDomains',
      '/users/$count',
      '/groups/$count',
      '/applications/$count',
      '/devices/$count',
      '/subscribedSkus',
      '/admin/serviceAnnouncement/healthOverviews?$select=service,status',
    ]);
    expect(call!.body.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(
      call!.body.requests.filter((r) => r.headers?.ConsistencyLevel === 'eventual').map((r) => r.id),
    ).toEqual(['users', 'groups', 'apps', 'devices']);

    expect(body.org).toEqual({
      id: '00000000-0000-4000-8000-00000000e0e0',
      name: 'Example Org',
      domains: [
        { name: 'example.com', isDefault: true, isInitial: false },
        { name: 'exampleorg.onmicrosoft.com', isDefault: false, isInitial: true },
      ],
    });
    expect(body.counts).toEqual({ users: 1284, groups: 342, apps: 87, devices: 1530 });
    expect(body.skus).toEqual([
      { sku: 'SPE_E5', used: 1104, total: 1200 },
      { sku: 'EMS', used: 62, total: 100 },
    ]);
    expect(body.health).toEqual({
      items: [
        { service: 'Exchange Online', status: 'serviceOperational' },
        { service: 'Microsoft Teams', status: 'serviceDegradation' },
      ],
    });
    expect(body.errors).toBeUndefined();
    expect(body.provenance.health).toMatchObject({
      service: 'graph',
      path: '/admin/serviceAnnouncement/healthOverviews',
      requestId: 'req-batch-1',
    });
    expect(Object.keys(body.provenance).sort()).toEqual([
      'apps',
      'devices',
      'groups',
      'health',
      'org',
      'skus',
      'users',
    ]);
    await t.app.close();
  });

  it('partial failure: forbidden sections carry a hint instead of failing the page', async () => {
    const batch = fixture('overview-batch.json') as {
      responses: Array<{ id: string; status: number; body: unknown }>;
    };
    const forbidden = (message: string) => ({ status: 403, body: { error: { code: 'Forbidden', message } } });
    for (const r of batch.responses) {
      if (r.id === 'health')
        Object.assign(r, forbidden('Insufficient privileges to complete the operation.'));
      if (r.id === 'devices')
        Object.assign(r, forbidden('Insufficient privileges to complete the operation.'));
      if (r.id === 'skus')
        Object.assign(r, {
          status: 503,
          body: { error: { code: 'serviceUnavailable', message: 'Try later' } },
        });
    }
    const t = await liveApp(() => json(batch));
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    const body = OverviewResponse.parse(res.json());
    expect(body.health).toEqual({
      error: {
        code: 'Forbidden',
        message: 'Insufficient privileges to complete the operation.',
        hint: expect.stringContaining('ServiceHealth.Read.All'),
      },
    });
    expect(body.counts).toEqual({ users: 1284, groups: 342, apps: 87, devices: null });
    expect(body.errors!.devices!.hint).toContain('Device.Read.All');
    expect(body.skus).toEqual([]);
    expect(body.errors!.skus!.hint).toMatch(/temporary problem/);
    expect(body.org.name).toBe('Example Org');
    await t.app.close();
  });

  it('licence errors say so', async () => {
    const batch = fixture('overview-batch.json') as {
      responses: Array<{ id: string; status: number; body: unknown }>;
    };
    const health = batch.responses.find((r) => r.id === 'health')!;
    Object.assign(health, {
      status: 403,
      body: {
        error: { code: 'Forbidden', message: 'Tenant does not have a SKU required for this operation.' },
      },
    });
    const t = await liveApp(() => json(batch));
    const body = OverviewResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } })).json(),
    );
    expect('error' in body.health && body.health.error.hint).toMatch(/licences/);
    await t.app.close();
  });

  it('CAE: a claims challenge is retried once with a token for those claims', async () => {
    const claims = JSON.stringify({ access_token: { nbf: { essential: true, value: '1700000000' } } });
    const challenge = `Bearer realm="", error="insufficient_claims", claims="${Buffer.from(claims).toString('base64')}"`;
    const t = await liveApp((n) =>
      n === 1
        ? json(
            {
              error: {
                code: 'InvalidAuthenticationToken',
                message: 'Continuous access evaluation resulted in challenge',
              },
            },
            401,
            { 'www-authenticate': challenge },
          )
        : json(fixture('overview-batch.json')),
    );
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(t.calls[1]!.headers.Authorization).toBe('Bearer token-read-claims');
    expect(t.auth.tokens.at(-1)).toMatchObject({
      kind: 'read',
      claims,
      scopes: ['https://graph.microsoft.com/.default'],
    });
    await t.app.close();
  });

  it('CAE: when the claims can only be met interactively → 401 reauth URL carrying the claims', async () => {
    const claims = JSON.stringify({ access_token: { nbf: { essential: true, value: '1700000000' } } });
    const challenge = `Bearer error="insufficient_claims", claims="${Buffer.from(claims).toString('base64')}"`;
    const t = await liveApp(() =>
      json({ error: { code: 'InvalidAuthenticationToken', message: 'challenge' } }, 401, {
        'www-authenticate': challenge,
      }),
    );
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(401);
    const err = ApiErrorBody.parse(res.json()).error;
    expect(err.code).toBe('reauth');
    const reauth = new URL(err.reauth!.url, 'http://localhost');
    expect(reauth.pathname).toBe('/auth/login');
    expect(Buffer.from(reauth.searchParams.get('claims')!, 'base64url').toString('utf8')).toBe(claims);

    // Following that URL sends the claims to Entra.
    const login = await t.app.inject({ method: 'GET', url: err.reauth!.url, headers: { cookie: t.cookie } });
    expect(new URL(login.headers.location as string).searchParams.get('claims')).toBe(claims);
    expect(t.auth.authUrls.at(-1)).toMatchObject({ claims, loginHint: 'avery@example.com' });
    await t.app.close();
  });

  it('a whole-batch failure maps to an upstream ApiErrorBody', async () => {
    const t = await liveApp(() =>
      json({ error: { code: 'Authorization_RequestDenied', message: 'Denied' } }, 403, {
        'request-id': 'req-x',
      }),
    );
    const res = await t.app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'upstream_forbidden',
      message: 'Denied',
      hint: 'Microsoft request-id req-x',
    });
    expect((await getMe(t.app, t.cookie)).res.statusCode).toBe(200);
    await t.app.close();
  });
});
