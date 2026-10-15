import { ApiError } from '@adminforge/connectors';
import type { AutomationTokenProvider } from '@adminforge/api/src/auth/automation';
import type { LicenceService, TenantLicences } from '@adminforge/api/src/capabilities/licences';
import { AppError } from '@adminforge/api/src/errors';
import { OutboundError } from '@adminforge/api/src/execution/outbound';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { runProbe, type DnsResolver, type ProbeDeps, type TlsInspector } from '@adminforge/api/src/probes/checks';
import { effectiveThresholds } from '@adminforge/api/src/probes/thresholds';
import { selectProbes } from '@adminforge/api/src/schedules/jobs';
import type { Connection } from '@adminforge/schemas';
import { FakeDefinitions, probe } from './helpers';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

class FakeOutbound implements OutboundExecutor {
  readonly calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  constructor(public respond: (call: ServiceCall) => unknown = () => ({})) {}
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({ identity, call });
    const data = (await this.respond(call)) as T;
    return { data, status: 200, provenance: { service: call.service, path: call.pathTemplate ?? call.path, ms: 3 } };
  }
}

function deps(o: Partial<ProbeDeps> & { outbound?: OutboundExecutor } = {}): ProbeDeps {
  const tokens: string[] = [];
  const automation: AutomationTokenProvider = {
    clientId: 'automation-client',
    credential: 'certificate',
    token: async (scope, opts) => {
      tokens.push(`${scope}${opts?.forceRefresh ? ' (fresh)' : ''}`);
      return 'token';
    },
  };
  return {
    outbound: new FakeOutbound(),
    automation,
    connection: async () => ({ kind: 'connection', id: 'integrations.example', version: '1.0.0', title: 'x', owner: 'x', baseUrl: 'https://func.example.com/api', audience: 'api://example', operations: { health: { method: 'GET', path: '/health', mode: 'read' } }, health: 'health' }) as unknown as Connection,
    env: () => ({ AF_PRIMARY_DOMAIN: 'example.com', PUBLIC_BASE_URL: 'https://portal.example.com', AF_LOG_ANALYTICS_WORKSPACE_ID: '00000000-0000-4000-8000-00000000aaaa' }),
    now: () => NOW,
    fetch: async () => new Response('{"token_endpoint":"x"}', { status: 200 }),
    ...o,
  };
}

const graph = (extra: Record<string, unknown> = {}) => probe('probes.g', { check: { kind: 'graph', path: '/organization', query: { $select: 'id' } }, ...extra });

describe('probe checks', () => {
  describe('http', () => {
    const http = (expect: Record<string, unknown> = {}, url = '${ env.PUBLIC_BASE_URL & "/readyz" }') => probe('probes.h', { check: { kind: 'http', url, expect } });
    it('passes with a 2xx and the expected text, measuring latency', async () => {
      const seen: string[] = [];
      const o = await runProbe('probes.h', http({ bodyContains: 'token_endpoint' }), deps({ fetch: async (u) => (seen.push(String(u)), new Response('{"token_endpoint":"x"}')) }));
      expect(o).toMatchObject({ status: 'ok', code: 'ok', unit: 'ms', probeKey: 'probes.h' });
      expect(o.metric).toBeGreaterThanOrEqual(0);
      expect(seen).toEqual(['https://portal.example.com/readyz']);
    });
    it.each([
      ['an unexpected status', async () => new Response('nope', { status: 503 }), {}, 'crit', 'expectation_failed', /returned 503; expected 2xx/],
      ['missing text', async () => new Response('hello'), { bodyContains: 'token_endpoint' }, 'crit', 'expectation_failed', /does not contain/],
      ['a refused connection', async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), {}, 'crit', 'unreachable', /ECONNREFUSED/],
    ])('fails on %s', async (_l, fetch, expect_, status, code, message) => {
      const o = await runProbe('probes.h', http(expect_), deps({ fetch: fetch as typeof globalThis.fetch }));
      expect(o).toMatchObject({ status, code });
      expect(o.message).toMatch(message);
    });
    it('accepts an expected non-2xx status', async () =>
      expect(await runProbe('probes.h', http({ status: [401, 403] }), deps({ fetch: async () => new Response('', { status: 401 }) }))).toMatchObject({ status: 'ok' }));
    it('reports a URL whose env key is missing as not configured', async () =>
      expect(await runProbe('probes.h', http({}, '${ env.NOPE }'), deps())).toMatchObject({ status: 'error', code: 'not_configured' }));
  });

  describe('graph / arm', () => {
    it('calls as the automation identity in read mode and applies latency thresholds', async () => {
      const outbound = new FakeOutbound(() => ({ value: [{ id: 'x' }] }));
      const o = await runProbe('probes.g', graph({ thresholds: { warn: 0, crit: 100_000 } }), deps({ outbound }));
      expect(o).toMatchObject({ status: 'warn', code: 'threshold' });
      expect(outbound.calls[0]).toMatchObject({ identity: { kind: 'automation', mode: 'read' }, call: { service: 'graph', method: 'GET', path: '/organization', query: { $select: 'id' } } });
    });
    it.each([
      ['permission missing', new OutboundError(new ApiError(403, 'Authorization_RequestDenied', 'Insufficient privileges'), 'graph', 'The automation identity needs Organization.Read.All.', false), 'error', 'forbidden'],
      ['licence missing', new OutboundError(new ApiError(403, 'NotLicensed', 'Tenant is not licensed'), 'graph', 'Requires a licence.', true), 'error', 'licence_required'],
      ['service unavailable', new OutboundError(new ApiError(503, 'ServiceUnavailable', 'Try later'), 'graph', 'Temporary.', false), 'crit', 'upstream_error'],
      ['network failure', new ApiError(0, 'NetworkError', 'socket hang up'), 'crit', 'unreachable'],
      ['automation identity not configured', new AppError(503, 'automation_not_configured', 'The automation identity is not configured.'), 'error', 'not_configured'],
    ])('maps %s', async (_l, err, status, code) => {
      const o = await runProbe('probes.g', graph(), deps({ outbound: new FakeOutbound(() => Promise.reject(err)) }));
      expect(o).toMatchObject({ status, code, metric: null });
    });
    it('passes ARM api-versions through', async () => {
      const outbound = new FakeOutbound(() => ({ value: [] }));
      await runProbe('probes.a', probe('probes.a', { check: { kind: 'arm', path: '/subscriptions', apiVersion: '2022-12-01' } }), deps({ outbound }));
      expect(outbound.calls[0]!.call).toMatchObject({ service: 'arm', path: '/subscriptions', apiVersion: '2022-12-01' });
    });
  });

  describe('tokenAcquisition', () => {
    it('acquires a fresh app-only token for the service audience', async () => {
      const scopes: string[] = [];
      const d = deps();
      d.automation = { ...d.automation!, token: async (scope, opts) => (scopes.push(`${scope}|${opts?.forceRefresh}`), 'token') };
      expect(await runProbe('probes.t', probe('probes.t', { check: { kind: 'tokenAcquisition', service: 'logAnalytics' } }), d)).toMatchObject({ status: 'ok' });
      expect(await runProbe('probes.t', probe('probes.t', { check: { kind: 'tokenAcquisition', connection: 'integrations.example' } }), d)).toMatchObject({ status: 'ok' });
      expect(scopes).toEqual(['https://api.loganalytics.io/.default|true', 'api://example/.default|true']);
    });
    it('is not configured without the identity or the SharePoint tenant name', async () => {
      expect(await runProbe('probes.t', probe('probes.t', { check: { kind: 'tokenAcquisition', service: 'graph' } }), deps({ automation: null }))).toMatchObject({ status: 'error', code: 'not_configured' });
      expect(await runProbe('probes.t', probe('probes.t', { check: { kind: 'tokenAcquisition', service: 'sharepointAdmin' } }), deps())).toMatchObject({ status: 'error', code: 'not_configured' });
    });
    it('turns a token failure critical', async () => {
      const d = deps();
      d.automation = { ...d.automation!, token: async () => Promise.reject(new AppError(502, 'automation_token_failed', 'AADSTS7000215: Invalid client secret.')) };
      expect(await runProbe('probes.t', probe('probes.t', { check: { kind: 'tokenAcquisition', service: 'graph' } }), d)).toMatchObject({ status: 'crit', code: 'token_failed' });
    });
  });

  describe('functionHealth', () => {
    it('calls the connection health operation as the automation identity', async () => {
      const outbound = new FakeOutbound(() => ({ status: 'Healthy' }));
      const o = await runProbe('probes.f', probe('probes.f', { check: { kind: 'functionHealth', connection: 'integrations.example', expect: { bodyContains: 'Healthy' } } }), deps({ outbound }));
      expect(o.status).toBe('ok');
      expect(outbound.calls[0]!.call).toMatchObject({ service: 'function', connection: 'integrations.example', operation: 'health' });
    });
  });

  describe('dnsResolve', () => {
    const dns = (answers: string[] | Error): DnsResolver => ({ resolve: async () => (answers instanceof Error ? Promise.reject(answers) : answers) });
    const mx = probe('probes.mx', { check: { kind: 'dnsResolve', name: '${ env.AF_PRIMARY_DOMAIN }', type: 'MX', expect: { contains: ['mail.protection.outlook.com'], minAnswers: 1 } } });
    it('passes when an answer contains the expected value', async () => {
      const o = await runProbe('probes.mx', mx, deps({ dns: dns(['example-com.mail.protection.outlook.com']) }));
      expect(o).toMatchObject({ status: 'ok', details: { rows: [{ type: 'MX', answer: 'example-com.mail.protection.outlook.com' }] } });
    });
    it.each([
      ['a missing record', Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }), 'crit', 'expectation_failed'],
      ['a resolver failure', Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }), 'crit', 'unreachable'],
      ['the wrong answer', ['mx.other.example'], 'crit', 'expectation_failed'],
      ['no answers', [], 'crit', 'expectation_failed'],
    ])('fails on %s', async (_l, answers, status, code) => expect(await runProbe('probes.mx', mx, deps({ dns: dns(answers as string[] | Error) }))).toMatchObject({ status, code }));
    it('reports an empty name as not configured', async () =>
      expect(await runProbe('probes.mx', mx, deps({ env: () => ({}), dns: dns([]) }))).toMatchObject({ status: 'error', code: 'not_configured' }));
  });

  describe('certExpiry', () => {
    const tls = (validTo: string, authorized = true): TlsInspector => ({ inspect: async () => ({ validFrom: new Date(days(-60)), validTo: new Date(validTo), authorized, ...(authorized ? {} : { authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' }) }) });
    const cert = probe('probes.c', { check: { kind: 'certExpiry', host: '${ $replace(env.PUBLIC_BASE_URL, /^https?:\\/\\/([^\\/:]+).*$/, "$1") }', warnDays: 21, critDays: 7 } });
    it.each([
      [40, true, 'ok'],
      [21, true, 'warn'],
      [7, true, 'crit'],
      [-2, true, 'crit'],
      [40, false, 'warn'],
    ])('%i days left (trusted: %s) → %s', async (n, trusted, status) => {
      const o = await runProbe('probes.c', cert, deps({ tls: tls(days(n), trusted) }));
      expect(o).toMatchObject({ status, metric: n, unit: 'days' });
    });
    it('fails when no TLS handshake completes', async () => {
      const o = await runProbe('probes.c', cert, deps({ tls: { inspect: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) } }));
      expect(o).toMatchObject({ status: 'crit', code: 'unreachable' });
    });
  });

  describe('appCredentialExpiry', () => {
    const apps = {
      value: [
        { id: 'o1', appId: 'a1', displayName: 'Example One', passwordCredentials: [{ keyId: 'k1', displayName: 'old', endDateTime: days(-3) }, { keyId: 'k2', endDateTime: days(12) }], keyCredentials: [{ keyId: 'k3', endDateTime: days(5) }] },
        { id: 'o2', appId: 'a2', displayName: 'Example Two', passwordCredentials: [{ keyId: 'k4', endDateTime: days(200) }] },
      ],
    };
    it('measures the soonest unexpired credential and counts the expired ones', async () => {
      const outbound = new FakeOutbound(() => apps);
      const o = await runProbe('probes.ace', probe('probes.ace', { check: { kind: 'appCredentialExpiry', warnDays: 30, critDays: 7 } }), deps({ outbound }));
      expect(o).toMatchObject({ status: 'crit', metric: 5, unit: 'days' });
      expect(o.message).toMatch(/2 within 30 days; 1 expired/);
      expect(o.details!.rows.map((r) => r.daysRemaining)).toEqual([5, 12, 200, -3]);
      expect(outbound.calls[0]!.call).toMatchObject({ path: '/applications', paging: 'all' });
    });
    it('can look at secrets only', async () => {
      const o = await runProbe('probes.ace', probe('probes.ace', { check: { kind: 'appCredentialExpiry', include: ['secrets'] } }), deps({ outbound: new FakeOutbound(() => apps) }));
      expect(o).toMatchObject({ status: 'warn', metric: 12 });
    });
  });

  describe('licenseThreshold', () => {
    const skus = { value: [{ skuPartNumber: 'SPE_E3', consumedUnits: 45, prepaidUnits: { enabled: 50, warning: 0 } }, { skuPartNumber: 'EMS', consumedUnits: 49, prepaidUnits: { enabled: 50 } }] };
    const lic = (sku: string, extra: Record<string, unknown> = {}) => probe('probes.l', { check: { kind: 'licenseThreshold', sku, maxPercent: 90, critPercent: 98, ...extra } });
    it('reports the share of seats in use against maxPercent / critPercent', async () => {
      expect(await runProbe('probes.l', lic('SPE_E3'), deps({ outbound: new FakeOutbound(() => skus) }))).toMatchObject({ status: 'warn', metric: 90, unit: '%' });
      expect(await runProbe('probes.l', lic('${ env.AF_SKU }'), deps({ outbound: new FakeOutbound(() => skus), env: () => ({ AF_SKU: 'ems' }) }))).toMatchObject({ status: 'crit', metric: 98 });
    });
    it('says when the tenant has no such subscription', async () =>
      expect(await runProbe('probes.l', lic('SPE_E5'), deps({ outbound: new FakeOutbound(() => skus) }))).toMatchObject({ status: 'error', code: 'not_found' }));
  });

  describe('signInHealth', () => {
    const signIns = (total: number, failed: number) => ({ value: Array.from({ length: total }, (_, i) => ({ id: `s${i}`, status: { errorCode: i < failed ? 50126 : 0, failureReason: i < failed ? 'Invalid username or password.' : '' } })) });
    const sh = probe('probes.s', { check: { kind: 'signInHealth', window: 'PT1H', maxFailurePercent: 25, minSignIns: 50, appId: '${ env.AF_APP }' }, thresholds: { warn: 10 } });
    it('computes the failure rate over the window and groups failure reasons', async () => {
      const outbound = new FakeOutbound(() => signIns(100, 30));
      const o = await runProbe('probes.s', sh, deps({ outbound, env: () => ({ AF_APP: '00000000-0000-4000-8000-0000000000AA' }) }));
      expect(o).toMatchObject({ status: 'crit', metric: 30, details: { rows: [{ errorCode: 50126, signIns: 30 }], totalRows: 100 } });
      expect(outbound.calls[0]!.call.query).toMatchObject({ $filter: "createdDateTime ge 2026-10-15T11:00:00Z and appId eq '00000000-0000-4000-8000-0000000000aa'" });
    });
    it('does not judge too few sign-ins', async () =>
      expect(await runProbe('probes.s', sh, deps({ outbound: new FakeOutbound(() => signIns(10, 9)), env: () => ({ AF_APP: '00000000-0000-4000-8000-0000000000aa' }) }))).toMatchObject({ status: 'ok', code: 'insufficient_data', metric: null }));
    it('needs the app id it names', async () => expect(await runProbe('probes.s', sh, deps())).toMatchObject({ status: 'error', code: 'not_configured' }));
  });

  describe('kql', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `/subscriptions/x/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa${i}`, name: `sa${i}`, failures: i + 1, blob: 'x'.repeat(400) }));
    it('counts Resource Graph rows (service total) and keeps capped details', async () => {
      const outbound = new FakeOutbound(() => ({ value: rows(3), totalRecords: 120 }));
      const p = probe('probes.k', { check: { kind: 'kql', source: 'resourceGraph', query: 'resources | where type =~ ${ $kql("microsoft.storage/storageaccounts") }', detailsLimit: 2 }, thresholds: { warn: 1, crit: 100 } });
      const o = await runProbe('probes.k', p, deps({ outbound }));
      expect(o).toMatchObject({ status: 'crit', metric: 120, unit: 'rows', code: 'threshold' });
      expect(o.details).toMatchObject({ totalRows: 120, truncated: true });
      expect(o.details!.rows).toHaveLength(2);
      expect(String(o.details!.rows[0]!.blob)).toHaveLength(298);
      expect(outbound.calls[0]!.call).toMatchObject({ service: 'arm', method: 'POST', path: '/providers/Microsoft.ResourceGraph/resources', body: { query: 'resources | where type =~ "microsoft.storage/storageaccounts"' } });
    });
    it('is ok with no offending rows and warns on any row by default', async () => {
      const p = probe('probes.k', { check: { kind: 'kql', source: 'resourceGraph', query: 'resources' } });
      expect(effectiveThresholds(p)).toMatchObject({ warn: 1, crit: null });
      expect(await runProbe('probes.k', p, deps({ outbound: new FakeOutbound(() => ({ value: [], totalRecords: 0 })) }))).toMatchObject({ status: 'ok', metric: 0 });
      expect(await runProbe('probes.k', p, deps({ outbound: new FakeOutbound(() => ({ value: rows(1), totalRecords: 1 })) }))).toMatchObject({ status: 'warn', metric: 1 });
    });
    it('aggregates a Log Analytics column in the default workspace', async () => {
      const outbound = new FakeOutbound(() => ({ value: rows(4), tables: [{ columns: [{ name: 'failures', type: 'long' }] }] }));
      const p = probe('probes.la', { check: { kind: 'kql', source: 'logAnalytics', query: 'AzureActivity', timespan: 'PT1H', metric: { column: 'failures', aggregate: 'sum' } }, thresholds: { warn: 5, crit: 20 } });
      const o = await runProbe('probes.la', p, deps({ outbound }));
      expect(o).toMatchObject({ status: 'warn', metric: 10, unit: 'failures' });
      expect(outbound.calls[0]!.call).toMatchObject({ service: 'logAnalytics', path: '/v1/workspaces/00000000-0000-4000-8000-00000000aaaa/query', body: { query: 'AzureActivity', timespan: 'PT1H' } });
    });
    it('reports a missing workspace cleanly', async () => {
      const p = probe('probes.la', { check: { kind: 'kql', source: 'logAnalytics', query: 'AzureActivity' } });
      const o = await runProbe('probes.la', p, deps({ env: () => ({}) }));
      expect(o).toMatchObject({ status: 'error', code: 'not_configured' });
      expect(o.message).toMatch(/AF_LOG_ANALYTICS_WORKSPACE_ID/);
    });
    it('runs advanced hunting through Graph and checks the licence first', async () => {
      const outbound = new FakeOutbound(() => ({ schema: [{ name: 'application', type: 'String' }], results: [{ application: 'Example' }] }));
      const p = probe('probes.ah', { check: { kind: 'kql', source: 'advancedHunting', query: 'CloudAppEvents | take 1', timespan: 'P1D' }, requires: { licences: ['defender'] } });
      const licensed = { get: async () => ({ skus: [], names: new Set(['DEFENDER_ENDPOINT_P2', 'MTP', 'WINDEFATP']), providedBy: new Map() }) as TenantLicences } as unknown as LicenceService;
      const unlicensed = { get: async () => ({ skus: [], names: new Set<string>(), providedBy: new Map() }) as TenantLicences } as unknown as LicenceService;
      expect(await runProbe('probes.ah', p, deps({ outbound, licences: unlicensed }))).toMatchObject({ status: 'error', code: 'licence_required' });
      expect(outbound.calls).toHaveLength(0);
      expect(await runProbe('probes.ah', p, deps({ outbound, licences: licensed }))).toMatchObject({ status: 'warn', metric: 1 });
      expect(outbound.calls[0]!.call).toMatchObject({ service: 'graph', method: 'POST', path: '/security/runHuntingQuery', body: { Query: 'CloudAppEvents | take 1', Timespan: 'P1D' } });
    });
    it('reports a broken query as an error, not a failing check', async () => {
      const p = probe('probes.k', { check: { kind: 'kql', source: 'resourceGraph', query: 'resources | whre' } });
      const o = await runProbe('probes.k', p, deps({ outbound: new FakeOutbound(() => Promise.reject(new OutboundError(new ApiError(400, 'BadRequest', 'Query is invalid'), 'arm', 'Check the query.', false))) }));
      expect(o).toMatchObject({ status: 'error', code: 'bad_request' });
    });
  });
});

describe('probe selection', () => {
  it('selects active probes carrying every tag, sorted by key', async () => {
    const defs = new FakeDefinitions()
      .set(probe('probes.b', { tags: ['sweep-1h', 'dns'] }))
      .set(probe('probes.a', { tags: ['sweep-1h'] }))
      .set(probe('probes.c', { tags: ['sweep-1h'], status: 'draft' }))
      .set(probe('probes.d', { tags: ['sweep-6h'] }));
    const keys = async (job: Parameters<typeof selectProbes>[0]) => (await selectProbes(job, defs as never)).map((p) => p.key);
    expect(await keys({ kind: 'probe', select: { tags: ['sweep-1h'] } })).toEqual(['probes.a', 'probes.b']);
    expect(await keys({ kind: 'probe', select: { tags: ['sweep-1h', 'dns'] } })).toEqual(['probes.b']);
    expect(await keys({ kind: 'probe', refs: ['probes.d', 'probes.c'] })).toEqual(['probes.d', 'probes.c']);
    expect(await keys({ kind: 'probe', ref: 'probes.c' })).toEqual(['probes.c']);
  });
});
