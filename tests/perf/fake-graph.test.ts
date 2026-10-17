import { createFakeGraph } from './graph/fake-graph';
import { parseFilter, evaluate, ODataError } from './graph/odata';
import { createTenant, SCALES } from './tenant/generate';

// The fake Graph behaves like Graph where it changes cost or correctness (paging, advanced queries, $count, caps),
// and refuses what it doesn't model. Small scale, so this runs in seconds (the heavy suite is datasources.test.ts).

const tenant = createTenant(SCALES.small);
const graph = createFakeGraph(tenant);
const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await graph.fetch(`https://graph.microsoft.com/v1.0${path}`, { headers });
  const text = await res.text();
  return {
    status: res.status,
    body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
};
const EVENTUAL = { ConsistencyLevel: 'eventual' };

describe('synthetic tenant', () => {
  it('is deterministic and has the tricky values', () => {
    const again = createTenant(SCALES.small);
    expect(again.users[123]).toEqual(tenant.users[123]);
    expect(tenant.users.some((u) => String(u.surname).includes("'"))).toBe(true);
    expect(tenant.users.some((u) => [...String(u.displayName)].some((c) => c.charCodeAt(0) > 0x7f))).toBe(
      true,
    );
    expect(tenant.groupUserMembers(tenant.allCompany).count).toBe(SCALES.small!.users);
  });

  it('membership is consistent both ways', () => {
    const g = tenant.groups.findIndex((_, i) => i > 3 && tenant.groupUserMembers(i).count > 5);
    const m = tenant.groupUserMembers(g);
    for (let k = 0; k < m.count; k++) expect(tenant.groupHasUser(g, m.at(k))).toBe(true);
    const members = new Set(Array.from({ length: m.count }, (_, k) => m.at(k)));
    expect(members.size).toBe(m.count);
    const outsider = Array.from({ length: SCALES.small!.users }, (_, i) => i).find((i) => !members.has(i))!;
    expect(tenant.groupHasUser(g, outsider)).toBe(false);
  });
});

describe('fake Graph', () => {
  it('pages with nextLink and honours $top caps', async () => {
    const first = await get('/users?$top=999&$select=id,displayName');
    expect(first.body.value).toHaveLength(999);
    expect(first.body['@odata.nextLink']).toContain('$skiptoken=999');
    const next = await graph.fetch(first.body['@odata.nextLink']);
    expect(((await next.json()) as { value: unknown[] }).value).toHaveLength(
      Math.min(999, SCALES.small!.users - 999),
    );
    expect((await get('/users?$top=1000')).status).toBe(400);
    const signIn = await get('/users?$top=999&$select=id,signInActivity');
    expect(signIn.body.value).toHaveLength(120);
  });

  it('needs ConsistencyLevel for $count, /$count, $search and advanced filters', async () => {
    expect((await get('/users/$count')).status).toBe(400);
    expect((await get('/users/$count', EVENTUAL)).body).toBe(String(SCALES.small!.users));
    expect((await get('/users?$search="displayName:avery"')).status).toBe(400);
    const s = await get('/users?$search="displayName:avery"&$count=true', EVENTUAL);
    expect(s.body['@odata.count']).toBeGreaterThan(0);
    expect((await get("/users?$filter=userType ne 'Guest'")).status).toBe(400);
    const ne = await get("/users?$filter=userType ne 'Guest'&$count=true", EVENTUAL);
    expect(ne.status).toBe(200);
    const guests = tenant.users.filter((u) => u.userType === 'Guest').length;
    expect(ne.body['@odata.count']).toBe(SCALES.small!.users - guests);
  });

  it('filters with lambdas, dates, enums and apostrophes', async () => {
    const sku = tenant.subscribedSkus[0]!.skuId;
    const lic = await get(`/users?$filter=assignedLicenses/any(l:l/skuId eq ${sku})&$count=true`, EVENTUAL);
    expect(lic.body['@odata.count']).toBe(
      tenant.users.filter((u) =>
        (u.assignedLicenses as Array<{ skuId: string }>).some((l) => l.skuId === sku),
      ).length,
    );
    const obrien = tenant.users.find((u) => u.surname === "O'Brien")!;
    const q = await get(`/users?$filter=${encodeURIComponent(`surname eq 'O''Brien'`)}&$top=999`);
    expect(q.body.value.map((u: { id: string }) => u.id)).toContain(obrien.id);
    const f = parseFilter(
      "riskState eq microsoft.graph.riskState'atRisk' and riskLastUpdatedDateTime ge 2026-01-01T00:00:00Z",
    );
    expect(evaluate(f.expr, { riskState: 'atRisk', riskLastUpdatedDateTime: '2026-02-01T00:00:00Z' })).toBe(
      true,
    );
    expect(() => parseFilter("displayName eq 'x' xor 1")).toThrow(ODataError);
  });

  it('owners/$count eq 0 and $expand=owners on groups', async () => {
    const res = await get('/groups?$filter=owners/$count eq 0&$count=true&$top=999&$select=id', EVENTUAL);
    expect(res.body['@odata.count']).toBe(tenant.groupOwners.filter((o) => o.length === 0).length);
    const ex = await get('/groups?$top=5&$expand=owners($select=id,displayName)&$select=id,displayName');
    expect(ex.body.value[0]).toHaveProperty('owners');
  });

  it('scans sign-ins by time window with a work budget', async () => {
    const res = await get(
      `/auditLogs/signIns?$filter=${encodeURIComponent('createdDateTime ge 2026-10-15T11:00:00Z')}&$top=500`,
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toHaveLength(500);
    expect(
      res.body.value.every((s: { createdDateTime: string }) => s.createdDateTime >= '2026-10-15T11:00:00Z'),
    ).toBe(true);
    expect((await get('/auditLogs/signIns?$count=true')).status).toBe(400);
  });

  it('answers $batch and getByIds, and refuses what it does not model', async () => {
    const res = await graph.fetch('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          { id: 'a', method: 'GET', url: '/users/$count', headers: EVENTUAL },
          { id: 'b', method: 'GET', url: '/nonsense' },
        ],
      }),
    });
    const body = (await res.json()) as { responses: Array<{ id: string; status: number; body: unknown }> };
    expect(body.responses.find((r) => r.id === 'a')).toMatchObject({
      status: 200,
      body: String(SCALES.small!.users),
    });
    expect(body.responses.find((r) => r.id === 'b')!.status).toBe(404);
    expect([...graph.stats.unmodelled.keys()].some((k) => k.includes('/nonsense'))).toBe(true);
    const ids = await graph.fetch('https://graph.microsoft.com/v1.0/directoryObjects/getByIds', {
      method: 'POST',
      body: JSON.stringify({ ids: [tenant.users[0]!.id, tenant.groups[0]!.id] }),
    });
    expect(((await ids.json()) as { value: unknown[] }).value).toHaveLength(2);
    expect((await get('/users?$apply=groupby(department)')).status).toBe(400);
  });

  it('throttles every Nth request with Retry-After', async () => {
    const g = createFakeGraph(tenant, { throttleEvery: 2, retryAfterSec: 3 });
    await g.fetch('https://graph.microsoft.com/v1.0/organization');
    const res = await g.fetch('https://graph.microsoft.com/v1.0/organization');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
  });
});
