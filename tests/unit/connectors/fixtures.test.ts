import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createArmClient,
  createFixtureFetch,
  createGraphClient,
  createLogAnalyticsClient,
  createResourceGraphClient,
  fixtureKey,
} from '@adminforge/connectors';
import { repoRoot } from '../../lib/repo';

const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const SUB = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000c1';
const opts = (fetch: typeof globalThis.fetch) => ({ getToken: async () => 'fixture-token', fetch, sleep: async () => {} });

describe('fixtureKey', () => {
  it('maps Graph requests by version, path, method and sorted query', () => {
    expect(fixtureKey('get', "https://graph.microsoft.com/v1.0/users?$top=5&$filter=userType eq 'Guest'").candidates).toEqual([
      'graph/v1.0/users/GET__$filter=usertype_eq__guest_&$top=5.json',
      'graph/v1.0/users/GET.json',
    ]);
    expect(fixtureKey('GET', 'https://graph.microsoft.com/v1.0/users/$count').candidates).toEqual(['graph/v1.0/users/$count/GET.json']);
  });
  it('drops ARM api-version and lower-cases the path', () =>
    expect(fixtureKey('GET', `https://management.azure.com/subscriptions/${SUB}/resourceGroups?api-version=2021-04-01`)).toEqual({
      service: 'arm',
      candidates: [`arm/subscriptions/${SUB}/resourcegroups/GET.json`],
    }));
  it('gives Resource Graph and Log Analytics one folder each', () => {
    expect(fixtureKey('POST', 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01').candidates).toEqual(['resourceGraph/POST.json']);
    expect(fixtureKey('POST', `https://api.loganalytics.io/v1/workspaces/${WS}/query`).candidates).toEqual([`logAnalytics/${WS}/POST.json`]);
  });
  it('uses hosts/<host> for anything else', () =>
    expect(fixtureKey('GET', 'https://func-hr-sync.example.com/api/employees').candidates).toEqual(['hosts/func-hr-sync.example.com/api/employees/GET.json']));
  it('hashes long queries and neutralises unsafe characters', () => {
    const long = fixtureKey('GET', `https://graph.microsoft.com/v1.0/users?$filter=${'x'.repeat(200)}`).candidates[0]!;
    expect(long).toMatch(/^graph\/v1\.0\/users\/GET__h[0-9a-f]{16}\.json$/);
    expect(fixtureKey('GET', 'https://graph.microsoft.com/v1.0/a%2F..%2F..%2Fsecret').candidates).toEqual(['graph/v1.0/a_.._.._secret/GET.json']);
  });
});

describe('createFixtureFetch with tests/fixtures', () => {
  const fetch = createFixtureFetch(FIXTURES);
  it('pages through ARM subscriptions via nextLink', async () => {
    const arm = createArmClient(opts(fetch));
    const subs = await arm.all<{ displayName: string }>({ path: '/subscriptions', apiVersion: '2022-12-01' });
    expect(subs.map((s) => s.displayName)).toEqual(['Example Org Production', 'Example Org Development']);
  });
  it('serves envelope fixtures with status and headers', async () => {
    const res = await fetch(
      `https://management.azure.com/subscriptions/${SUB}/resourceGroups/rg-example-functions/providers/Microsoft.Web/sites/func-example/restart?api-version=2022-03-01`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ms-ratelimit-remaining-subscription-writes')).toBe('1199');
  });
  it('picks Resource Graph variants by query text', async () => {
    const rg = createResourceGraphClient(opts(fetch));
    const arc = await rg.query({ query: "resources | where type =~ 'Microsoft.HybridCompute/machines' | project name, status" });
    expect(arc.rows.map((r) => r.name)).toEqual(['srv-example-01', 'srv-example-02']);
    const generic = await rg.query({ query: 'resources | project name, type' });
    expect(generic).toMatchObject({ totalRecords: 3, skipToken: 'page2' });
  });
  it('answers Log Analytics queries as typed rows', async () => {
    const la = createLogAnalyticsClient(opts(fetch));
    const r = await la.query({ workspace: WS, query: 'AppRequests | summarize by bin(TimeGenerated, 1h)', timespan: 'P1D' });
    expect(r.rows[1]).toEqual({ TimeGenerated: '2026-01-10T01:00:00Z', AppRoleName: 'func-example', Requests: 4980, Failures: 40, Healthy: false, TopError: { code: 'HostUnavailable', count: 31 } });
    expect((await la.query({ workspace: WS, query: 'SigninLogs | summarize count()' })).rows).toEqual([{ Total: 1200, Failures: 18, FailureRate: 1.5 }]);
  });
  it('answers 404 JSON naming the file to create', async () => {
    const res = await fetch('https://management.azure.com/subscriptions/nope?api-version=2022-12-01');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'FixtureNotFound', message: expect.stringContaining('arm/subscriptions/nope/GET.json') } });
    const arm = createArmClient(opts(fetch));
    await expect(arm.request({ path: '/subscriptions/nope', apiVersion: '2022-12-01' })).rejects.toMatchObject({ status: 404, code: 'FixtureNotFound' });
  });
  it('accepts Request objects', async () => {
    const res = await fetch(new Request('https://management.azure.com/subscriptions?api-version=2022-12-01'));
    expect((await res.json()).value).toHaveLength(1);
  });
});

describe('createFixtureFetch in a scratch directory', () => {
  let dir: string;
  const put = (rel: string, content: unknown) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-fixtures-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers the exact-query file and falls back to the method file', async () => {
    put('graph/v1.0/users/GET.json', { value: [{ id: 'all' }] });
    put("graph/v1.0/users/GET__$filter=usertype_eq__guest_.json", { value: [{ id: 'guest' }] });
    const g = createGraphClient(opts(createFixtureFetch(dir)));
    expect((await g.request<{ value: Array<{ id: string }> }>({ path: '/users', query: { $filter: "userType eq 'Guest'" } })).data.value[0]!.id).toBe('guest');
    expect((await g.request<{ value: Array<{ id: string }> }>({ path: '/users', query: { $top: 5 } })).data.value[0]!.id).toBe('all');
  });
  it('answers Graph $batch by resolving each sub-request', async () => {
    put("graph/v1.0/users/$count/GET__$filter=usertype_eq__member_.json", 1180);
    put('graph/v1.0/organization/GET.json', { value: [{ displayName: 'Example Org' }] });
    const g = createGraphClient(opts(createFixtureFetch(dir)));
    const out = await g.batch([
      { id: 'members', path: '/users/$count', query: { $filter: "userType eq 'Member'" }, headers: { ConsistencyLevel: 'eventual' } },
      { id: 'org', path: '/organization' },
      { id: 'missing', path: '/groups' },
    ]);
    expect(out.members).toEqual({ status: 200, body: 1180 });
    expect(out.org).toEqual({ status: 200, body: { value: [{ displayName: 'Example Org' }] } });
    expect(out.missing).toMatchObject({ status: 404, body: { error: { code: 'FixtureNotFound' } } });
  });
  it('serves numbers as text/plain (Graph $count)', async () => {
    put('graph/v1.0/users/$count/GET.json', 42);
    const g = createGraphClient(opts(createFixtureFetch(dir)));
    expect((await g.request<number>({ path: '/users/$count' })).data).toBe(42);
  });
  it('matches variants on query values', async () => {
    put('hosts/func.example.com/api/items/GET.json', {
      $fixture: { variants: [{ match: { query: { state: 'open' } }, body: ['open-item'] }], status: 404, body: { error: { code: 'NotFound', message: 'none' } } },
    });
    const fetch = createFixtureFetch(dir);
    expect(await (await fetch('https://func.example.com/api/items?state=OPEN')).json()).toEqual(['open-item']);
    expect((await fetch('https://func.example.com/api/items?state=closed')).status).toBe(404);
  });
  it('can accept unmatched writes for mock-mode flows', async () => {
    const strict = createFixtureFetch(dir);
    const lenient = createFixtureFetch(dir, { acceptWrites: true });
    const url = 'https://graph.microsoft.com/v1.0/users/00000000-0000-4000-8000-000000000001';
    expect((await strict(url, { method: 'PATCH', body: '{}' })).status).toBe(404);
    expect((await lenient(url, { method: 'PATCH', body: '{}' })).status).toBe(204);
    expect((await lenient(url)).status).toBe(404);
  });
  it('reports which file served each request', async () => {
    put('graph/v1.0/me/GET.json', { id: 'me' });
    const seen: Array<{ file?: string; status: number }> = [];
    const fetch = createFixtureFetch(dir, { onRequest: (i) => seen.push({ file: i.file, status: i.status }) });
    await fetch('https://graph.microsoft.com/v1.0/me');
    await fetch('https://graph.microsoft.com/v1.0/you');
    expect(seen).toEqual([{ file: 'graph/v1.0/me/GET.json', status: 200 }, { file: undefined, status: 404 }]);
  });
  it('fails loudly on invalid fixture JSON', async () => {
    put('graph/v1.0/broken/GET.json', '{ nope');
    await expect(createFixtureFetch(dir)('https://graph.microsoft.com/v1.0/broken')).rejects.toThrow(/not valid JSON/);
  });
  it('never reads outside the fixtures directory', async () => {
    writeFileSync(path.join(dir, '..', `af-outside-${path.basename(dir)}.json`), '{"secret":true}');
    try {
      const res = await createFixtureFetch(dir)(`https://graph.microsoft.com/v1.0/..%2F..%2Faf-outside-${path.basename(dir)}`);
      expect(res.status).toBe(404);
    } finally {
      rmSync(path.join(dir, '..', `af-outside-${path.basename(dir)}.json`), { force: true });
    }
  });
});
