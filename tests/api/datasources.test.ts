import { ApiErrorBody, DatasourceExecuteManyResponse, DatasourceResult } from '@adminforge/schemas';
import { fixturesApp, json, liveApp, setupContent, TEST_USERS, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

const post = (t: { app: Awaited<ReturnType<typeof fixturesApp>>['app'] }, url: string, cookie: string, csrf: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: { cookie, 'x-adminforge-csrf': csrf }, payload: payload as object });

describe('POST /api/datasources/execute (fixtures)', () => {
  it('renders the published request, pages with an opaque cursor, caches per user, and reports provenance', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const first = await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users', params: {} });
    expect(first.statusCode).toBe(200);
    const a = DatasourceResult.parse(first.json());
    expect((a.data as { value: unknown[] }).value).toHaveLength(3);
    expect(a.cursor).toBeTruthy();
    expect(a.cursor).not.toContain('graph.microsoft.com');
    expect(a.provenance).toMatchObject({ service: 'graph', path: '/users' });
    expect(a.provenance!.cachedAt).toBeUndefined();

    const next = DatasourceResult.parse((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users', params: {}, cursor: a.cursor })).json());
    expect((next.data as { value: Array<{ displayName: string }> }).value.map((u) => u.displayName)).toEqual(['Dana =SUM(A1)']);
    expect(next.cursor).toBeUndefined();

    const again = DatasourceResult.parse((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users', params: {} })).json());
    expect(again.provenance!.cachedAt).toBeTruthy();

    const bad = await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users', params: {}, cursor: 'forged.cursor' });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorBody.parse(bad.json()).error.code).toBe('invalid_cursor');
    await t.app.close();
  });

  it('graphBatch: per-sub-request values, with errors (and hints) for the ones that failed', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = DatasourceResult.parse((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'counts' })).json());
    expect(res.data).toEqual({ members: 3, guests: null });
    expect(res.errors!.guests).toMatchObject({ code: 'Authorization_RequestDenied' });
    expect(res.errors!.guests!.hint).toContain('User.Read.All');
    await t.app.close();
  });

  it('transform runs over all pages (report)', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = DatasourceResult.parse((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.expiry', datasource: 'creds', params: { days: '60' } })).json());
    expect(res.data).toMatchObject({ total: 3 });
    expect((res.data as { rows: Array<{ app: string }> }).rows.map((r) => r.app)).toEqual(['Example HR Sync', 'Example HR Sync', 'Example Portal']);
    await t.app.close();
  });

  it('execute-many: every datasource of the page, with partial failures per datasource and skipped `when`', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await post(t, '/api/datasources/execute-many', cookie, csrf, { page: 'identity.users', params: {} });
    expect(res.statusCode).toBe(200);
    const body = DatasourceExecuteManyResponse.parse(res.json());
    expect(Object.keys(body.results).sort()).toEqual(['counts', 'later', 'users']);
    expect(body.results.later).toMatchObject({ data: null, skipped: true, provenance: null });
    expect(body).toMatchObject({ page: 'identity.users', version: '1.0.0' });

    const some = DatasourceExecuteManyResponse.parse((await post(t, '/api/datasources/execute-many', cookie, csrf, { page: 'identity.users', datasources: ['later', 'nope'], params: { userType: 'Guest' } })).json());
    expect(some.results.later).toMatchObject({ data: { shown: true } });
    expect(some.results.nope).toEqual({ error: { code: 'datasource_not_found', message: expect.any(String) } });
    await t.app.close();
  });

  it('validates params, page, datasource, roles and CSRF', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const bad = await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users', params: { userType: 'Admin', extra: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorBody.parse(bad.json()).error).toMatchObject({ code: 'invalid_params' });
    expect(ApiErrorBody.parse(bad.json()).error.message).toMatch(/userType.*extra|extra.*userType/);
    expect((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.nope', datasource: 'users' })).statusCode).toBe(404);
    expect(ApiErrorBody.parse((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'nope' })).json()).error.code).toBe('datasource_not_found');
    expect((await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', url: 'https://graph.microsoft.com/v1.0/users' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/datasources/execute', headers: { cookie }, payload: { page: 'identity.users', datasource: 'users' } })).statusCode).toBe(403);
    await t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: { cookie, 'x-adminforge-csrf': csrf }, payload: { roles: ['Playbook.Author'] } });
    const forbidden = await post(t, '/api/datasources/execute', cookie, csrf, { page: 'identity.users', datasource: 'users' });
    expect(forbidden.statusCode).toBe(403);
    expect(ApiErrorBody.parse(forbidden.json()).error.code).toBe('forbidden');
    await t.app.close();
  });

  it('licence-gated pages answer licence_required without calling Microsoft', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await post(t, '/api/datasources/execute', cookie, csrf, { page: 'security.risky-users', datasource: 'risky' });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({ code: 'licence_required', message: 'Requires AAD_PREMIUM_P2.' });
    await t.app.close();
  });
});

describe('POST /api/datasources/execute (live, fake Graph)', () => {
  it("quotes user input into $filter with $odata(), sends the read token, and maps a 403 to a hint", async () => {
    let status = 200;
    const t = await liveApp(env, () => (status === 200 ? json({ value: TEST_USERS }, 200, { 'request-id': 'ms-1' }) : json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } }, 403)));
    const res = await post(t, '/api/datasources/execute', t.cookie, t.csrf, { page: 'identity.users', datasource: 'users', params: { userType: 'Guest', department: "O'Brien & Co", q: 'av"ery' } });
    expect(res.statusCode).toBe(200);
    const call = t.calls.at(-1)!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/users');
    expect(url.searchParams.get('$filter')).toBe("userType eq 'Guest' and department eq 'O''Brien & Co'");
    expect(url.searchParams.get('$search')).toBe('"displayName:av\\"ery"');
    expect(call.headers.Authorization).toBe('Bearer token-read');
    expect(call.headers.ConsistencyLevel).toBe('eventual');
    expect(call.headers['client-request-id']).toBe(res.headers['x-correlation-id']);
    expect(DatasourceResult.parse(res.json()).provenance).toMatchObject({ requestId: 'ms-1', path: '/users' });

    status = 403;
    const denied = await post(t, '/api/datasources/execute', t.cookie, t.csrf, { page: 'identity.users', datasource: 'users', params: { userType: 'Member' } });
    expect(denied.statusCode).toBe(403);
    const err = ApiErrorBody.parse(denied.json()).error;
    expect(err.code).toBe('upstream_forbidden');
    expect(err.hint).toContain('User.Read.All');
    expect(err.hint).toContain('Directory Readers');
    await t.app.close();
  });

  it('caches per user + params: a different filter is a different call', async () => {
    const t = await liveApp(env, () => json({ value: [] }));
    for (const params of [{}, {}, { userType: 'Member' }]) await post(t, '/api/datasources/execute', t.cookie, t.csrf, { page: 'identity.users', datasource: 'users', params });
    expect(t.calls.filter((c) => c.url.includes('/v1.0/users'))).toHaveLength(2);
    await t.app.close();
  });
});
