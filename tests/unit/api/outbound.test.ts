import path from 'node:path';
import { ApiError, isTransient } from '@adminforge/connectors';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import { AppError } from '@adminforge/api/src/errors';
import { createOutboundExecutor, OutboundError, outboundAppError, PolicyDenied, templatePath, type OutboundDeps } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';
import { createFixtureFetch } from '@adminforge/connectors';
import type { Connection } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const USER = '44444444-5555-4666-8777-888888888888';

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  idHash: 'sid-hash',
  userOid: USER,
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: '11111111-2222-4333-8444-555555555555',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
  csrf: 'x',
  readAccountId: 'read-acct',
  writeAccountId: null,
  writeExpiresAt: null,
  writeExtended: false,
  writeReason: null,
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  ip: null,
  userAgent: null,
  ...overrides,
});
const armed = () => session({ writeAccountId: 'write-acct', writeExpiresAt: new Date(NOW.getTime() + 600_000) });
const read = (s = session()): ExecutionIdentity => ({ kind: 'delegated', session: s, mode: 'read' });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Fake Microsoft endpoints: `route` answers each call (JSON by default); every call is recorded. */
function cloud(route: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const c: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return route(c);
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'ms-req-1', ...headers } });

function fakeAuth() {
  const tokens: Array<{ kind: string; scopes: string[]; claims?: string }> = [];
  const auth = {
    token: async (i: { kind: 'read' | 'write'; scopes: string[]; claims?: string }) => {
      tokens.push({ kind: i.kind, scopes: i.scopes, ...(i.claims ? { claims: i.claims } : {}) });
      return `token-${i.kind}`;
    },
  } as unknown as AuthClient;
  return { auth, tokens };
}

const CONNECTION: Connection = {
  kind: 'connection',
  id: 'example.hr-sync',
  version: '1.0.0',
  title: 'HR sync',
  owner: 'test',
  baseUrl: '${ env.AF_HR_SYNC_URL }',
  audience: 'api://00000000-0000-4000-8000-0000000000f1',
  operations: {
    getEmployee: { method: 'GET', path: '/employees/{id}', mode: 'read' },
    resync: { method: 'POST', path: '/resync', mode: 'write' },
  },
};

function executor(over: Partial<OutboundDeps> & { fetch: typeof fetch }) {
  const { auth, tokens } = fakeAuth();
  const automationScopes: string[] = [];
  const deps: OutboundDeps = {
    config: { DATA_MODE: 'live', AF_SPO_TENANT_NAME: undefined, OUTBOUND_CONCURRENCY: 16, OUTBOUND_USER_CONCURRENCY: 6, OUTBOUND_TIMEOUT_MS: 5000, TOKEN_CACHE_KEY: undefined },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: {
      clientId: 'automation-app',
      credential: 'secret',
      token: async (scope) => {
        automationScopes.push(scope);
        return 'token-app';
      },
    },
    connection: async (key) => {
      if (key !== CONNECTION.id) throw new AppError(404, 'definition_not_found', 'no');
      return CONNECTION;
    },
    env: () => ({ AF_HR_SYNC_URL: 'https://hr.example.com/api' }),
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
    ...over,
  };
  return { out: createOutboundExecutor(deps), tokens, automationScopes };
}

describe('outbound executor', () => {
  it('delegated Graph GET: Read-app token, client-request-id = correlation id, provenance path without ids', async () => {
    const c = cloud(() => json({ id: 'x', displayName: 'Avery' }));
    const { out, tokens } = executor({ fetch: c.fetch });
    const res = await out.execute(read(), { service: 'graph', method: 'GET', path: `/users/${USER}`, query: { $select: 'id,displayName' } }, { correlationId: 'corr-1' });
    expect(res.data).toEqual({ id: 'x', displayName: 'Avery' });
    expect(c.calls[0]!.url).toBe(`https://graph.microsoft.com/v1.0/users/${USER}?$select=id%2CdisplayName`);
    expect(c.calls[0]!.headers.Authorization).toBe('Bearer token-read');
    expect(c.calls[0]!.headers['client-request-id']).toBe('corr-1');
    expect(tokens[0]).toEqual({ kind: 'read', scopes: ['https://graph.microsoft.com/.default'] });
    expect(res.provenance).toMatchObject({ service: 'graph', path: '/users/{id}', requestId: 'ms-req-1' });
    expect(res.provenance.ms).toBeGreaterThanOrEqual(0);
  });

  it('read mode refuses writes before any token or network call (ADR-003), even when declared', async () => {
    const c = cloud(() => json({}));
    const { out, tokens } = executor({ fetch: c.fetch });
    for (const call of [
      { service: 'graph' as const, method: 'PATCH', path: `/users/${USER}`, body: { accountEnabled: false } },
      { service: 'graph' as const, method: 'PATCH', path: `/users/${USER}`, body: { accountEnabled: false }, declaredWrite: true },
      { service: 'arm' as const, method: 'DELETE', path: '/subscriptions/x/resourceGroups/rg', apiVersion: '2022-09-01' },
    ]) {
      const err = await out.execute(read(), call).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PolicyDenied);
      expect((err as AppError).status).toBe(403);
    }
    expect(c.calls).toEqual([]);
    expect(tokens).toEqual([]);
  });

  it('write mode: only declared writes leave, with the Write-app token while armed; NotArmed otherwise', async () => {
    const c = cloud(() => new Response(null, { status: 204 }));
    const { out, tokens } = executor({ fetch: c.fetch });
    const call = { service: 'graph' as const, method: 'PATCH', path: `/users/${USER}`, body: { accountEnabled: false } };
    await expect(out.execute({ kind: 'delegated', session: armed(), mode: 'write' }, call)).rejects.toMatchObject({ code: 'policy_denied' });
    const res = await out.execute({ kind: 'delegated', session: armed(), mode: 'write' }, { ...call, declaredWrite: true });
    expect(res.status).toBe(204);
    expect(c.calls[0]!.headers.Authorization).toBe('Bearer token-write');
    expect(tokens.at(-1)!.kind).toBe('write');
    await expect(out.execute({ kind: 'delegated', session: session(), mode: 'write' }, { ...call, declaredWrite: true })).rejects.toMatchObject({ name: 'NotArmed' });
  });

  it('$batch: spec items become wire requests, are policy-checked one by one, and $count bodies are decoded', async () => {
    const c = cloud((call) => {
      const reqs = (call.body as { requests: Array<{ id: string; url: string }> }).requests;
      return json({ responses: reqs.map((r) => ({ id: r.id, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(r.id === 'members' ? '5' : '1').toString('base64') })) });
    });
    const { out } = executor({ fetch: c.fetch });
    const res = await out.execute<{ responses: Array<{ id: string; status: number; body: unknown }> }>(read(), {
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: {
        requests: [
          { id: 'members', path: '/users/$count', query: { $filter: "userType eq 'Member'" }, headers: { ConsistencyLevel: 'eventual' } },
          { id: 'guests', url: "/users/$count?$filter=userType eq 'Guest'" },
        ],
      },
    });
    expect(res.data.responses).toEqual([
      { id: 'members', status: 200, body: 5 },
      { id: 'guests', status: 200, body: 1 },
    ]);
    const sent = c.calls[0]!.body as { requests: Array<{ id: string; method: string; url: string; headers?: Record<string, string> }> };
    expect(sent.requests[0]).toEqual({ id: 'members', method: 'GET', url: "/users/$count?$filter=userType%20eq%20'Member'", headers: { ConsistencyLevel: 'eventual' } });
    expect(res.provenance.path).toBe('/$batch');

    await expect(
      out.execute(read(), { service: 'graph', method: 'POST', path: '/$batch', body: { requests: [{ id: 'a', method: 'PATCH', path: `/users/${USER}`, body: {} }] } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('paging all follows nextLink up to maxItems and keeps @odata.count; nextLinks leaving Graph are refused', async () => {
    const c = cloud((call) =>
      call.url.includes('skiptoken=p2')
        ? json({ value: [{ id: 3 }, { id: 4 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=p3' })
        : json({ '@odata.count': 9, value: [{ id: 1 }, { id: 2 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=p2' }),
    );
    const { out } = executor({ fetch: c.fetch });
    const res = await out.execute<{ value: unknown[]; '@odata.count': number }>(read(), { service: 'graph', method: 'GET', path: '/users', paging: 'all', maxItems: 3 });
    expect(res.data).toEqual({ value: [{ id: 1 }, { id: 2 }, { id: 3 }], '@odata.count': 9 });
    expect(c.calls).toHaveLength(2);

    const evil = cloud(() => json({ value: [], '@odata.nextLink': 'https://evil.example.com/steal' }));
    await expect(executor({ fetch: evil.fetch }).out.execute(read(), { service: 'graph', method: 'GET', path: '/users', paging: 'all' })).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('cursor paging hands out sealed cursors bound to the call; tampered or foreign cursors are rejected', async () => {
    const c = cloud((call) =>
      call.url.includes('skiptoken=p2') ? json({ value: [{ id: 2 }] }) : json({ value: [{ id: 1 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=p2' }),
    );
    const { out } = executor({ fetch: c.fetch });
    const first = await out.execute(read(), { service: 'graph', method: 'GET', path: '/users', paging: { pageSize: 1 } });
    expect(first.data).toEqual({ value: [{ id: 1 }] });
    expect(c.calls[0]!.url).toContain('$top=1');
    expect(first.nextCursor).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(first.nextCursor).not.toContain('skiptoken');
    const second = await out.execute(read(), { service: 'graph', method: 'GET', path: '/users', paging: { cursor: first.nextCursor } });
    expect(second.data).toEqual({ value: [{ id: 2 }] });
    expect(second.nextCursor).toBeUndefined();
    expect(c.calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=p2');

    const forged = `${Buffer.from('https://graph.microsoft.com/v1.0/users/x/memberOf').toString('base64url')}.${first.nextCursor!.split('.')[1]}`;
    await expect(out.execute(read(), { service: 'graph', method: 'GET', path: '/users', paging: { cursor: forged } })).rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
    await expect(out.execute(read(), { service: 'graph', method: 'GET', path: '/groups', paging: { cursor: first.nextCursor } })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('ARM: api-version is required; writes wait for the long-running operation', async () => {
    const c = cloud((call) => {
      if (call.url.startsWith('https://management.azure.com/operations/op1')) return json({ status: 'Succeeded' });
      if (call.method === 'PUT') return json({}, 201, { 'azure-asyncoperation': 'https://management.azure.com/operations/op1?api-version=2022-09-01' });
      return json({ id: '/subscriptions/s/resourceGroups/rg-a', properties: { provisioningState: 'Succeeded' } });
    });
    const { out } = executor({ fetch: c.fetch });
    await expect(out.execute(read(), { service: 'arm', method: 'GET', path: '/subscriptions' })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    const res = await out.execute(
      { kind: 'automation', mode: 'write' },
      { service: 'arm', method: 'PUT', path: '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-a', apiVersion: '2022-09-01', body: { location: 'westeurope' }, declaredWrite: true },
    );
    expect(c.calls.map((x) => x.method)).toEqual(['PUT', 'GET', 'GET']);
    expect(res.data).toMatchObject({ properties: { provisioningState: 'Succeeded' } });
    expect(res.provenance.path).toBe('/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}');
  });

  it('Resource Graph: rows and a skip-token cursor bound to the query', async () => {
    const c = cloud((call) => {
      const b = call.body as { options: { $skipToken?: string } };
      return b.options.$skipToken ? json({ totalRecords: 3, data: [{ name: 'c' }] }) : json({ totalRecords: 3, $skipToken: 'tok', data: [{ name: 'a' }, { name: 'b' }] });
    });
    const { out } = executor({ fetch: c.fetch });
    const call = { service: 'arm' as const, method: 'POST', path: '/providers/Microsoft.ResourceGraph/resources', body: { query: 'Resources | project name' } };
    const first = await out.execute<{ value: unknown[]; totalRecords: number }>(read(), { ...call, paging: {} });
    expect(first.data).toMatchObject({ value: [{ name: 'a' }, { name: 'b' }], totalRecords: 3 });
    const next = await out.execute(read(), { ...call, paging: { cursor: first.nextCursor } });
    expect(next.data).toMatchObject({ value: [{ name: 'c' }] });
    expect((c.calls[1]!.body as { options: { $skipToken: string } }).options.$skipToken).toBe('tok');
    await expect(out.execute(read(), { ...call, body: { query: 'Resources | project id' }, paging: { cursor: first.nextCursor } })).rejects.toMatchObject({ code: 'invalid_cursor' });
    const all = await out.execute<{ value: unknown[] }>(read(), { ...call, paging: 'all' });
    expect(all.data.value).toHaveLength(3);
  });

  it('Log Analytics: rows + tables; the workspace id stays out of provenance', async () => {
    const c = cloud(() => json({ tables: [{ name: 'PrimaryResult', columns: [{ name: 'n', type: 'long' }], rows: [['7']] }] }));
    const { out, tokens } = executor({ fetch: c.fetch });
    const res = await out.execute<{ value: unknown[] }>(read(), {
      service: 'logAnalytics',
      method: 'POST',
      path: '/v1/workspaces/00000000-0000-4000-8000-0000000000c1/query',
      body: { query: 'Heartbeat | count', timespan: 'P1D' },
    });
    expect(res.data.value).toEqual([{ n: 7 }]);
    expect(res.provenance.path).toBe('/v1/workspaces/{workspace}/query');
    expect(tokens[0]!.scopes).toEqual(['https://api.loganalytics.io/.default']);
  });

  it('function connections: endpoint from the published connection (env), read ops allowed, write ops need a declared write', async () => {
    const c = cloud(() => json({ ok: true }));
    const { out, tokens, automationScopes } = executor({ fetch: c.fetch });
    const res = await out.execute(read(), { service: 'function', method: 'GET', path: 'getEmployee', connection: 'example.hr-sync', pathParams: { id: 'emp 42' } });
    expect(res.data).toEqual({ ok: true });
    expect(c.calls[0]!.url).toBe('https://hr.example.com/api/employees/emp%2042');
    // Encoded separators in a filled path never leave (path traversal guard).
    await expect(out.execute(read(), { service: 'function', method: 'GET', path: 'getEmployee', connection: 'example.hr-sync', pathParams: { id: 'a/b' } })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(tokens.at(-1)).toEqual({ kind: 'read', scopes: ['api://00000000-0000-4000-8000-0000000000f1/user_impersonation'] });
    expect(res.provenance.path).toBe('/employees/{id}');

    await expect(out.execute(read(), { service: 'function', method: 'GET', path: '', operation: 'resync', connection: 'example.hr-sync' })).rejects.toMatchObject({ code: 'policy_denied' });
    // `declaredRead` from a caller is ignored: the connection decides.
    await expect(out.execute(read(), { service: 'function', method: 'GET', path: '', operation: 'resync', connection: 'example.hr-sync', declaredRead: true })).rejects.toMatchObject({ code: 'policy_denied' });
    await out.execute({ kind: 'automation', mode: 'write' }, { service: 'function', method: 'POST', path: '', operation: 'resync', connection: 'example.hr-sync', declaredWrite: true });
    expect(automationScopes.at(-1)).toBe('api://00000000-0000-4000-8000-0000000000f1/.default');
    await expect(out.execute(read(), { service: 'function', method: 'GET', path: 'nope', connection: 'example.hr-sync' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('403 → OutboundError (still an ApiError) whose hint names the missing scopes and roles; routes map it', async () => {
    const c = cloud(() => json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, 403));
    const { out } = executor({ fetch: c.fetch });
    const err = (await out
      .execute(read(), { service: 'graph', method: 'GET', path: '/users', requires: { scopes: { graph: ['User.Read.All'] }, entraRoles: ['Directory Readers'] } })
      .catch((e: unknown) => e)) as OutboundError;
    expect(err).toBeInstanceOf(OutboundError);
    expect(err).toBeInstanceOf(ApiError);
    expect(isTransient(err)).toBe(false);
    expect(err.hint).toContain('User.Read.All');
    expect(err.hint).toContain('Read app');
    expect(err.hint).toContain('Directory Readers');
    expect(err.hint).toContain('ms-req-1');
    expect(err.provenance).toMatchObject({ service: 'graph', path: '/users' });
    const app = outboundAppError(err);
    expect(app).toMatchObject({ status: 403, code: 'upstream_forbidden' });
    expect(app.extras.hint).toBe(err.hint);

    const lic = cloud(() => json({ error: { code: 'AadPremiumLicenseRequired', message: 'The tenant needs an AAD Premium 2 license.' } }, 403));
    const licErr = (await executor({ fetch: lic.fetch })
      .out.execute(read(), { service: 'graph', method: 'GET', path: '/identityProtection/riskyUsers', requires: { licences: ['AAD_PREMIUM_P2'] } })
      .catch((e: unknown) => e)) as OutboundError;
    expect(licErr.licence).toBe(true);
    expect(licErr.hint).toContain('AAD_PREMIUM_P2');
    expect(outboundAppError(licErr)).toMatchObject({ status: 403, code: 'licence_required' });

    const arm = cloud(() => json({ error: { code: 'AuthorizationFailed', message: 'no' } }, 403));
    const armErr = (await executor({ fetch: arm.fetch })
      .out.execute({ kind: 'automation', mode: 'read' }, { service: 'arm', method: 'GET', path: '/subscriptions', apiVersion: '2022-12-01' })
      .catch((e: unknown) => e)) as OutboundError;
    expect(armErr.hint).toMatch(/automation identity needs the Azure role Reader/);
    const throttled = cloud(() => json({ error: { code: 'TooManyRequests', message: 'slow down' } }, 429));
    const t = await executor({ fetch: throttled.fetch }).out.execute(read(), { service: 'graph', method: 'GET', path: '/users' }).catch((e: unknown) => e);
    expect(isTransient(t)).toBe(true);
    expect(outboundAppError(t)).toMatchObject({ status: 429, code: 'throttled' });
  });

  it('automation identity: app-only token for the resource; 503 when the identity is not configured', async () => {
    const c = cloud(() => json({ value: [] }));
    const { out, automationScopes } = executor({ fetch: c.fetch });
    await out.execute({ kind: 'automation', mode: 'read' }, { service: 'graph', method: 'GET', path: '/organization' });
    expect(automationScopes).toEqual(['https://graph.microsoft.com/.default']);
    expect(c.calls[0]!.headers.Authorization).toBe('Bearer token-app');
    const none = executor({ fetch: c.fetch, automation: null }).out;
    await expect(none.execute({ kind: 'automation', mode: 'read' }, { service: 'graph', method: 'GET', path: '/organization' })).rejects.toMatchObject({ status: 503, code: 'automation_not_configured' });
  });

  it('DATA_MODE=fixtures: synthetic responses without any token (no broker needed)', async () => {
    const fixtures = path.join(repoRoot, 'tests/fixtures');
    const { out } = executor({
      fetch: createFixtureFetch(fixtures),
      broker: null,
      auth: null,
      config: { DATA_MODE: 'fixtures', AF_SPO_TENANT_NAME: undefined, OUTBOUND_CONCURRENCY: 4, OUTBOUND_USER_CONCURRENCY: 4, OUTBOUND_TIMEOUT_MS: 5000, TOKEN_CACHE_KEY: undefined },
    });
    const res = await out.execute<{ value: unknown[] }>(read(), { service: 'arm', method: 'GET', path: '/subscriptions', apiVersion: '2022-12-01', paging: 'all' });
    expect(res.data.value.length).toBeGreaterThanOrEqual(1);
  });

  it('mock sign-in with live data → 409 live_data_unavailable', async () => {
    const c = cloud(() => json({}));
    const { out } = executor({ fetch: c.fetch, broker: null, auth: null });
    await expect(out.execute(read(), { service: 'graph', method: 'GET', path: '/users' })).rejects.toMatchObject({ status: 409, code: 'live_data_unavailable' });
    expect(c.calls).toEqual([]);
  });

  it('limits concurrent calls per identity and service', async () => {
    let inFlight = 0;
    let peak = 0;
    const c = cloud(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return json({ value: [] });
    });
    const { out } = executor({
      fetch: c.fetch,
      config: { DATA_MODE: 'live', AF_SPO_TENANT_NAME: undefined, OUTBOUND_CONCURRENCY: 8, OUTBOUND_USER_CONCURRENCY: 2, OUTBOUND_TIMEOUT_MS: 5000, TOKEN_CACHE_KEY: undefined },
    });
    await Promise.all(Array.from({ length: 6 }, () => out.execute(read(), { service: 'graph', method: 'GET', path: '/users' })));
    expect(peak).toBe(2);
    expect(c.calls).toHaveLength(6);
  });

  it('PowerShell-only services are not REST calls', async () => {
    const { out } = executor({ fetch: cloud(() => json({})).fetch });
    await expect(out.execute(read(), { service: 'exchange', method: 'GET', path: '/x' })).rejects.toMatchObject({ status: 501 });
  });

  it('templatePath hides ids, UPNs and resource names', () => {
    expect(templatePath(`/users/${USER}/memberOf`)).toBe('/users/{id}/memberOf');
    expect(templatePath('/users/avery%40example.com')).toBe('/users/{upn}');
    expect(templatePath("/servicePrincipals(appId='abc')")).toBe("/servicePrincipals(appId='{id}')");
    expect(templatePath('/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-x/providers/Microsoft.Web/sites/func-x/functions/fn1')).toBe(
      '/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/Microsoft.Web/sites/{name}/functions/{name}',
    );
    expect(templatePath('/providers/Microsoft.ResourceGraph/resources')).toBe('/providers/Microsoft.ResourceGraph/resources');
    expect(templatePath('/security/incidents/4224')).toBe('/security/incidents/{id}');
  });
});
