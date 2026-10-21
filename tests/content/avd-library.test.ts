import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveParams } from '@adminforge/api/src/datasources/params';
import type { DefinitionRecord } from '@adminforge/api/src/definitions/types';
import { composeNav } from '@adminforge/api/src/routes/nav';
import { createFixtureFetch, tablesToRows } from '@adminforge/connectors';
import { lintExpressions, renderString, renderTemplate } from '@adminforge/expressions';
import { inputsSchema, loadContentDir, startsWithUnion, type Navigation } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The Azure Virtual Desktop section (portal/content/{dashboards,pages,reports,probes,playbooks}/avd*): its parent in
// the rail, every datasource run the way DATA_MODE=fixtures runs it (params resolved with their defaults, the request
// rendered, the fixture answered, then the transform — earlier datasources available as ds.<name>), the probes, the
// write playbooks' inputs and wiring, and the transforms at fleet size.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const records: DefinitionRecord[] = loaded.definitions.map((d) => ({
  kind: d.def.kind,
  key: d.def.id,
  version: d.def.version,
  sha256: d.sha256,
  def: d.def,
  status: 'published',
  source: 'fs',
  file: d.file,
}));
const keys = new Set(records.map((r) => r.key));
const fetchFixture = createFixtureFetch(path.join(repoRoot, 'tests/fixtures'));
const NOW = '2026-10-17T12:00:00Z';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000c1';
const user = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const POOL = `/subscriptions/${S1}/resourceGroups/rg-example-avd/providers/Microsoft.DesktopVirtualization/hostPools/hp-example-pooled`;
const HOST = `${POOL}/sessionHosts/avd-ex-0001.example.com`;
const SESSION = `${HOST}/userSessions/3`;

const PAGES = [
  'avd.host-pools',
  'avd.host-pool',
  'avd.session-hosts',
  'avd.session-host',
  'avd.user-sessions',
  'avd.connections',
];
const REPORTS = [
  'avd.session-host-health',
  'avd.host-pool-capacity',
  'avd.drained-session-hosts',
  'avd.connection-errors',
];
const PROBES = [
  'probes.avd-session-hosts-unavailable',
  'probes.avd-session-hosts-need-assistance',
  'probes.avd-host-pools-no-capacity',
  'probes.avd-host-pools-nearly-full',
  'probes.avd-connection-errors',
];
const PLAYBOOKS = ['avd.set-drain-mode', 'avd.log-off-user-session', 'avd.send-user-message'];
const VIEWS = ['avd.overview', ...PAGES, ...REPORTS];

const rgVariants = (
  JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/resourceGraph/POST.json'), 'utf8')).$fixture
    .variants as Array<{ match: { bodyIncludes?: unknown } }>
).map((v) => v.match.bodyIncludes);

/** Runs every datasource of a definition in order against the fixtures; returns results by name plus the requests. */
async function run(id: string, input: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const p = await resolveParams(def(id).params, input, { env, now: NOW, user } as never);
  const ds: Record<string, Def> = {};
  const requests: Record<string, Def> = {};
  for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
    const scope = { params: p, env, now: NOW, user, ds };
    if (d.when !== undefined && (await renderString(d.when, scope)) !== true) {
      ds[name] = null;
      continue;
    }
    let value: unknown;
    if (d.source === 'resourceGraph') {
      const q = (await renderString(d.query, scope)) as string;
      requests[name] = q;
      const res = await fetchFixture(
        'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
        { method: 'POST', body: JSON.stringify({ query: q, options: { resultFormat: 'objectArray' } }) },
      );
      expect([id, name, res.status]).toEqual([id, name, 200]);
      const body = (await res.json()) as { data: unknown[]; totalRecords: number };
      value = { value: body.data, totalRecords: body.totalRecords };
    } else if (d.source === 'arm') {
      const req = await renderTemplate<Def>(d.request, scope);
      requests[name] = req;
      const qs = new URLSearchParams({ 'api-version': req.apiVersion });
      for (const [k, v] of Object.entries<Def>(req.query ?? {}))
        if (v !== '' && v != null) qs.set(k, String(v));
      const res = await fetchFixture(`https://management.azure.com${req.path}?${qs}`, {
        method: req.method ?? 'GET',
      });
      expect([id, name, res.status]).toEqual([id, name, 200]);
      value = await res.json();
    } else if (d.source === 'logAnalytics') {
      const workspace = (await renderString(d.workspace, scope)) as string;
      const q = (await renderString(d.query, scope)) as string;
      requests[name] = { workspace, query: q };
      const res = await fetchFixture(`https://api.loganalytics.io/v1/workspaces/${workspace}/query`, {
        method: 'POST',
        body: JSON.stringify({ query: q }),
      });
      expect([id, name, res.status]).toEqual([id, name, 200]);
      const tables = tablesToRows(((await res.json()) as Def).tables);
      value = { value: tables[0]?.rows ?? [], tables };
    } else value = await renderTemplate(d.data, scope);
    ds[name] = d.transform ? await renderString(d.transform, { ...scope, value }) : value;
  }
  return { ds, requests, params: p };
}

describe('Azure Virtual Desktop in the navigation', () => {
  const navigation = def('portal.navigation') as Navigation;

  it('is a parent of its own after Azure, opening with its overview; its checks are on its row', () => {
    const order = [...navigation.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => s.key);
    expect(order.indexOf('avd')).toBe(order.indexOf('azure') + 1);
    const nav = composeNav({
      navigation,
      definitions: records,
      roles: ['Portal.Reader', 'Portal.Operator'],
      licences: null,
    });
    expect(nav.sections.find((s) => s.key === 'avd')!.items.map((i) => i.href)).toEqual([
      '/p/avd.overview',
      '/p/avd.host-pools',
      '/p/avd.session-hosts',
      '/p/avd.user-sessions',
      '/p/avd.connections',
    ]);
    // The rail shows the AVD probes' status on the section's row (their group is the section key).
    const active = (r: DefinitionRecord) => (r.def as { status?: string }).status !== 'retired';
    expect(
      records.some((r) => r.kind === 'probe' && (r.def as { group?: string }).group === 'avd' && active(r)),
    ).toBe(true);
  });

  it.each(VIEWS)('%s is a Reader view owned by the AVD team', (id) => {
    const d = def(id);
    expect(d.owner).toBe('avd-team');
    expect(d.requires.portalRoles).toEqual(['Portal.Reader']);
    expect(d.requires.azureRoles?.length).toBeGreaterThan(0);
    if (d.kind !== 'report' && d.nav) expect(d.nav.section).toBe('avd');
    expect(lintExpressions(d).map((w) => `${w.path}: ${w.message}`)).toEqual([]);
  });

  it.each(REPORTS)('%s is in the AVD catalogue area, exportable and findable', (id) => {
    const r = def(id);
    expect(r.kind).toBe('report');
    expect(r).toMatchObject({ area: 'avd', nav: { section: 'reports' } });
    expect(r.tags.length).toBeGreaterThanOrEqual(5);
    expect(r.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
    expect(r.layout.filter((b: Def) => b.widget === 'table').map((b: Def) => b.data)).toContain(
      r.export.data,
    );
  });

  it('the overview shows the AVD checks and links only to real pages', () => {
    const d = def('avd.overview');
    const probes = d.layout.filter((b: Def) => b.widget === 'probeStatus');
    expect(probes.map((b: Def) => b.group)).toEqual(['avd']);
    const text = d.layout
      .filter((b: Def) => b.widget === 'markdown')
      .map((b: Def) => b.text)
      .join('\n');
    const linked = [...text.matchAll(/\]\(\/p\/([a-z0-9.-]+)/g)].map((m) => m[1]!);
    expect(linked.sort()).toEqual(
      [...PAGES.filter((p) => !['avd.host-pool', 'avd.session-host'].includes(p)), ...REPORTS].sort(),
    );
    for (const key of linked) expect(keys.has(key), key).toBe(true);
    expect(text).toContain('/monitoring?group=avd');
    expect(text).toContain('/reports?area=avd');
  });
});

describe('Azure Virtual Desktop queries', () => {
  const rgDatasources = VIEWS.flatMap((id) =>
    Object.entries<Def>(def(id).datasources)
      .filter(([, d]) => d.source === 'resourceGraph')
      .map(([name, d]) => [id, name, d] as const),
  );

  it('tag every Resource Graph query uniquely, each with its own fixture', () => {
    const tags = rgDatasources.map(([, , d]) => String(d.query).split('\n')[0]);
    expect(new Set(tags).size).toBe(tags.length);
    for (const [id, name, d] of rgDatasources) {
      const tag = String(d.query).split('\n')[0]!;
      expect([id, name, tag.startsWith(`// af:${id}#`)]).toEqual([id, name, true]);
      expect([id, name, rgVariants.includes(tag.slice(3))]).toEqual([id, name, true]);
    }
  });

  it('send Resource Graph only what it accepts (no leading union, ≤ 3 joins, no let, no anti joins)', async () => {
    for (const [id, name] of rgDatasources) {
      const input =
        id === 'avd.host-pool' || id === 'avd.session-host'
          ? { id: id === 'avd.host-pool' ? POOL : HOST }
          : {};
      const { requests } = await run(id, input);
      const q = requests[name] as string | undefined;
      if (q === undefined) continue;
      expect(startsWithUnion(q)).toBe(false);
      expect([id, name, (q.match(/\|\s*join\b/g) ?? []).length <= 3]).toEqual([id, name, true]);
      expect(q).not.toMatch(/kind\s*=\s*(leftanti|leftsemi|rightanti|rightsemi)/i);
      expect(q).not.toMatch(/(^|\n)\s*let\s/);
    }
  });

  it('keep hostile filter values out of the KQL text', async () => {
    const hostile = "x' or 1 == 1 | project secrets //";
    const { requests } = await run('avd.session-hosts', { q: hostile, resourceGroup: hostile });
    // $kql() quotes the whole value as one string literal: outside its literals the query has nothing injected.
    expect(requests.hosts).toContain(`sessionHost contains "x' or 1 == 1 | project secrets //"`);
    expect(requests.hosts).toContain(`resourceGroup =~ "x' or 1 == 1 | project secrets //"`);
    const outside = (q: string) => q.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^'\n]*'/g, "''");
    expect(outside(requests.hosts)).not.toMatch(/project secrets|1 == 1/);
    const pools = await run('avd.host-pools', { q: hostile, resourceGroup: hostile });
    expect(outside(pools.requests.pools)).not.toMatch(/project secrets|1 == 1/);
    await expect(run('avd.session-hosts', { subscriptionId: hostile })).rejects.toThrow();
    // Patterned params refuse quotes before anything renders.
    await expect(run('avd.session-hosts', { hostPool: "hp' | take 1" })).rejects.toThrow();
    await expect(run('avd.host-pool', { id: `${POOL}' | project secrets` })).rejects.toThrow();
    await expect(run('avd.session-host', { id: `${POOL}/sessionHosts/../../x` })).rejects.toThrow();
    // Log Analytics: a UPN is quoted by $kql().
    const env = { AF_AVD_LOG_ANALYTICS_WORKSPACE_ID: WS };
    const la = await run('avd.connections', { upn: "o'brien@example.com" }, env);
    expect(la.requests.recent.query).toContain(`let who = "o'brien@example.com";`);
  });

  it('use the AVD workspace, or the default one, and skip Log Analytics when neither is set', async () => {
    const avd = await run('avd.connection-errors', {}, { AF_AVD_LOG_ANALYTICS_WORKSPACE_ID: WS });
    expect(avd.requests.errors.workspace).toBe(WS);
    const fallback = await run('avd.connection-errors', {}, { AF_LOG_ANALYTICS_WORKSPACE_ID: WS });
    expect(fallback.requests.errors.workspace).toBe(WS);
    const none = await run('avd.connection-errors');
    expect(none.ds.workspace).toEqual({ configured: false });
    expect([none.ds.errors, none.ds.daily, none.ds.totals]).toEqual([null, null, null]);
    // The key is configuration, declared for every installation.
    expect(readFileSync(path.join(repoRoot, 'config/example.env'), 'utf8')).toMatch(
      /^AF_AVD_LOG_ANALYTICS_WORKSPACE_ID=$/m,
    );
  });
});

describe('Azure Virtual Desktop pages over the fixtures', () => {
  it('session hosts: the fleet counted by Resource Graph, the rows untransformed', async () => {
    const { ds, requests } = await run('avd.session-hosts');
    expect(def('avd.session-hosts').datasources.hosts).toMatchObject({ paging: 'cursor' });
    expect(def('avd.session-hosts').datasources.hosts.transform).toBeUndefined();
    expect(ds.summary).toEqual({
      hosts: 12,
      available: 8,
      unhealthy: 2,
      needsAssistance: 2,
      shutdown: 1,
      drained: 2,
      sessions: 43,
    });
    expect(ds.hosts.value).toHaveLength(12);
    const filtered = await run('avd.session-hosts', {
      health: 'Unhealthy',
      drain: 'On',
      hosting: 'arc',
      hostPool: 'hp-example-pooled',
    });
    expect(filtered.requests.hosts).toContain("| where health == 'Unhealthy'");
    expect(filtered.requests.hosts).toContain('| where not(allowNewSession)');
    expect(filtered.requests.hosts).toContain("| where hosting == 'arc'");
    expect(filtered.requests.hosts).toContain('| where hostPool =~ "hp-example-pooled"');
    // One pool exactly by its id (names repeat across resource groups).
    const byId = await run('avd.session-hosts', { hostPoolId: POOL });
    expect(byId.requests.hosts).toContain(
      `| where tolower(id) startswith "${POOL.toLowerCase()}/sessionhosts/"`,
    );
    expect(requests.hosts).not.toContain('| where health ==');
  });

  it('host pools: capacity added up per pool, no session limit means no slots', async () => {
    const { ds, requests } = await run('avd.host-pools');
    const byName = Object.fromEntries(ds.pools.value.map((p: Def) => [p.name, p]));
    expect(byName['hp-example-finance']).toMatchObject({
      accepting: 2,
      sessions: 15,
      slots: 16,
      capacityUsed: 0.938,
    });
    expect(byName['hp-example-personal']).toMatchObject({ slots: null, capacityUsed: null, unassigned: 0 });
    // Unassigned desktops mean something only in a personal pool.
    expect(byName['hp-example-finance'].unassigned).toBeNull();
    expect(ds.summary).toMatchObject({ hostPools: 4, pooled: 3, personal: 1 });
    // Subscription names come from their own query: Resource Graph allows one cross-table join per query.
    expect(byName['hp-example-finance'].subscriptionName).toBe('Example Org Production');
    expect(byName['hp-example-personal'].subscriptionName).toBe('Example Org Development');
    expect(requests.pools).not.toMatch(/resourcecontainers/);
    // A pool's session hosts are opened by its id.
    const table = def('avd.host-pools').layout.find((b: Def) => b.id === 'pools');
    const href = (await renderString(table.rowActions.find((a: Def) => a.label === 'Session hosts').href, {
      row: byName['hp-example-finance'],
    })) as string;
    expect(new URL(href, 'https://portal.example.com').searchParams.get('hostPoolId')).toBe(
      byName['hp-example-finance'].id,
    );
  });

  it('host pool: configuration, its hosts, application groups, scaling plan and errors', async () => {
    const { ds, requests } = await run('avd.host-pool', { id: POOL }, { AF_LOG_ANALYTICS_WORKSPACE_ID: WS });
    expect(ds.pool).toMatchObject({
      name: 'hp-example-pooled',
      hosts: 6,
      accepting: 3,
      drained: 1,
      startable: 1,
      capacityUsed: 0.75,
    });
    expect(ds.hosts.value).toHaveLength(6);
    expect(ds.appGroups.value.map((a: Def) => a.applicationGroupType)).toEqual(['Desktop', 'RemoteApp']);
    expect(ds.scaling.value[0]).toMatchObject({ name: 'sp-example-weekdays', enabled: 'true' });
    expect(ds.errors.value[0]).toMatchObject({
      CodeSymbolic: 'ConnectionFailedNoHealthyRdshAvailable',
      ServiceError: false,
    });
    expect(requests.errors.query).toContain(`_ResourceId =~ "${POOL}"`);
    // Every Resource Graph filter compares the lower-cased id.
    expect(requests.hosts).toContain(`startswith "${POOL.toLowerCase()}/sessionhosts/"`);
  });

  it('session host: read live, health checks and sessions, the machine behind it', async () => {
    const { ds, requests } = await run('avd.session-host', { id: HOST });
    expect(requests.host.path).toBe(HOST);
    expect(ds.host).toMatchObject({
      name: 'avd-ex-0001.example.com',
      hostPool: 'hp-example-pooled',
      hostPoolId: POOL,
      drainMode: 'false',
      sessions: 10,
      failedChecks: 0,
      hosting: 'azure',
    });
    expect(ds.host.checks).toHaveLength(6);
    expect(ds.sessions.value).toHaveLength(10);
    expect(ds.machine).toMatchObject({ powerState: 'VM running' });

    const assist = await run('avd.session-host', { id: `${POOL}/sessionHosts/avd-ex-0004.example.com` });
    expect(assist.ds.host).toMatchObject({ status: 'NeedsAssistance', failedChecks: 1 });
    const arc = await run('avd.session-host', {
      id: `/subscriptions/00000000-0000-4000-8000-0000000000a2/resourcegroups/rg-example-avd-dev/providers/microsoft.desktopvirtualization/hostpools/hp-example-personal/sessionhosts/avd-dev-02.example.com`,
    });
    expect(arc.ds.host).toMatchObject({
      hosting: 'arc',
      assignedUser: 'j.silva@example.com',
      drainMode: 'false',
    });
  });

  it('user sessions: pick a pool, then the pool, one host or one person', async () => {
    const pick = await run('avd.user-sessions');
    expect(pick.ds.pools.value.map((p: Def) => p.name)[0]).toBe('hp-example-pooled');
    expect([pick.ds.sessions, pick.ds.counts]).toEqual([null, null]);

    const pool = await run('avd.user-sessions', { hostPoolId: POOL });
    expect(pool.requests.sessions.path).toBe(`${POOL}/userSessions`);
    expect(pool.requests.sessions.query.$filter).toBe('');
    expect(pool.ds.counts).toMatchObject({ total: 27, partial: false });
    expect(pool.ds.counts.active + pool.ds.counts.disconnected).toBe(27);

    const first = pool.ds.sessions.value[0].properties.userPrincipalName;
    const person = await run('avd.user-sessions', { hostPoolId: POOL, upn: first });
    expect(person.requests.sessions.query.$filter).toBe(`userPrincipalName eq '${first}'`);
    expect(person.ds.counts.total).toBeGreaterThan(0);
    expect(person.ds.counts.total).toBeLessThan(27);

    const host = await run('avd.user-sessions', {
      hostPoolId: POOL,
      sessionHost: 'avd-ex-0001.example.com',
      upn: first,
    });
    expect(host.requests.sessions.path).toBe(`${POOL}/sessionHosts/avd-ex-0001.example.com/userSessions`);
    expect(host.requests.sessions.query.$filter).toBe('');
    expect(host.ds.counts.total).toBe(10);
  });

  it('connections: success rate, failures over time, people, network, one person', async () => {
    const env = { AF_AVD_LOG_ANALYTICS_WORKSPACE_ID: WS };
    const all = await run('avd.connections', {}, env);
    expect(all.ds.summary).toMatchObject({ Attempts: 412, Connected: 389, SuccessRate: 0.9442 });
    expect(all.ds.trend.value).toHaveLength(6);
    expect(all.ds.people.value[0].Errors).toEqual(['ConnectionFailedNoHealthyRdshAvailable']);
    expect(all.ds.recent).toBeNull();
    expect(all.requests.summary.query).toContain("let pool = '';");
    const one = await run(
      'avd.connections',
      { upn: 'm.chen@example.com', hostPool: 'hp-example-finance' },
      env,
    );
    expect(one.ds.recent.value[0]).toMatchObject({ Outcome: 'Failed', HostPool: 'hp-example-finance' });
    expect(one.requests.errors.query).toContain('let pool = "/hostpools/hp-example-finance";');
  });

  it('overview: fleet counts, status split and the busiest pools', async () => {
    const { ds } = await run('avd.overview');
    expect(ds.hosts).toMatchObject({ hosts: 12, unhealthy: 2, hostPools: 4, sessions: 43 });
    expect(ds.byStatus.map((s: Def) => s.hosts).reduce((a: number, b: number) => a + b, 0)).toBe(12);
    expect(ds.busiest[0]).toMatchObject({ hostPool: 'hp-example-pooled', sessions: 27 });
    expect(ds.unhealthy.value.map((h: Def) => h.sessionHost)).toEqual([
      'avd-fin-03.example.com',
      'avd-ex-0003.example.com',
    ]);
  });
});

describe('Azure Virtual Desktop reports over the fixtures', () => {
  it('session host health: every problem with its failing checks', async () => {
    const { ds, requests } = await run('avd.session-host-health');
    expect(requests.hosts).toContain("| where health in ('Unhealthy', 'NeedsAssistance')");
    expect(ds.hosts.value.map((h: Def) => h.health)).toEqual([
      'Unhealthy',
      'Unhealthy',
      'NeedsAssistance',
      'NeedsAssistance',
    ]);
    expect(ds.hosts.value.find((h: Def) => h.sessionHost === 'avd-fin-03.example.com').failedChecks).toEqual([
      'DomainTrustCheck',
    ]);
    expect(ds.counts).toMatchObject({ unhealthy: 2, needsAssistance: 2 });
    const live = await run('avd.session-host-health', { health: 'Unhealthy', includeDrained: false });
    expect(live.requests.hosts).toContain("| where health == 'Unhealthy'");
    expect(live.requests.hosts).toContain('| where allowNewSession');
  });

  it('host pool capacity: no host, nearly full and the free slots across pools', async () => {
    const { ds, requests } = await run('avd.host-pool-capacity');
    expect(ds.pools.rows.map((p: Def) => p.capacity)).toEqual(['NoHost', 'NearlyFull', 'AllAssigned', 'Ok']);
    expect(requests.pools).not.toMatch(/resourcecontainers/);
    expect(ds.pools.rows.map((p: Def) => p.subscriptionName)).toContain('Example Org Development');
    expect(ds.pools).toMatchObject({
      pools: 4,
      noHost: 1,
      full: 0,
      nearlyFull: 1,
      sessions: 43,
      freeSlots: 10,
    });
  });

  it('drain mode: the drained hosts, and only the empty ones on request', async () => {
    const { ds } = await run('avd.drained-session-hosts');
    expect(ds.hosts.value.map((h: Def) => h.sessionHost)).toEqual([
      'avd-ex-0002.example.com',
      'avd-val-01.example.com',
    ]);
    expect(ds.counts).toMatchObject({ drained: 2, drainedEmpty: 2 });
    expect((await run('avd.drained-session-hosts', { emptyOnly: true })).requests.hosts).toContain(
      '| where sessions == 0',
    );
  });

  it('connection errors: grouped by code and host pool, per day, with totals', async () => {
    const { ds, requests } = await run(
      'avd.connection-errors',
      { hostPool: 'hp-example-finance' },
      { AF_LOG_ANALYTICS_WORKSPACE_ID: WS },
    );
    expect(ds.errors.value).toHaveLength(3);
    expect(new Set(ds.errors.value.map((e: Def) => e.Key)).size).toBe(3);
    expect(ds.daily.value).toHaveLength(7);
    expect(ds.totals).toMatchObject({ Failed: 87, People: 27 });
    expect(requests.errors.query).toContain("| where ActivityType =~ 'Connection'");
    const everything = await run(
      'avd.connection-errors',
      { activity: 'All' },
      { AF_LOG_ANALYTICS_WORKSPACE_ID: WS },
    );
    expect(everything.requests.errors.query).not.toContain("ActivityType =~ 'Connection'");
  });
});

describe('Azure Virtual Desktop probes', () => {
  it.each(PROBES)('%s says what to do and links to where to act', (id) => {
    const p = def(id);
    expect(p).toMatchObject({ kind: 'probe', group: 'avd', owner: 'avd-team', check: { kind: 'kql' } });
    expect(p.remedy.length).toBeGreaterThan(100);
    const key = /^\/p\/([^?]+)/.exec(p.link.href)?.[1];
    expect(key && keys.has(key)).toBe(true);
    expect(p.check.query.split('\n')[0]).toBe(`// af:${id}`);
    // The first column names the item, so the result can say which ones.
    expect(p.check.query).toMatch(/\| (project|summarize) .*\bname\b/);
  });

  it.each([
    ['probes.avd-session-hosts-unavailable', ['avd-fin-03.example.com', 'avd-ex-0003.example.com']],
    ['probes.avd-session-hosts-need-assistance', ['avd-ex-0004.example.com', 'avd-ex-0006.example.com']],
    ['probes.avd-host-pools-no-capacity', ['hp-example-validation']],
    ['probes.avd-host-pools-nearly-full', ['hp-example-finance']],
  ])('%s finds the synthetic problem hosts and pools', async (id, names) => {
    const res = await fetchFixture(
      'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
      {
        method: 'POST',
        body: JSON.stringify({ query: def(id).check.query }),
      },
    );
    const rows = ((await res.json()) as Def).data;
    expect(rows.map((r: Def) => r.name)).toEqual(names);
    expect(rows.length).toBeGreaterThanOrEqual(def(id).thresholds.warn);
  });

  it('the connection probe counts each failed attempt once, from the AVD workspace', async () => {
    const p = def('probes.avd-connection-errors');
    // An attempt that logs two error codes is in two groups: the metric is one distinct count, not their sum.
    expect(p.check).toMatchObject({
      source: 'logAnalytics',
      metric: { column: 'failedAttempts', aggregate: 'max' },
    });
    expect(p.check.query).toMatch(/toscalar\(failed \| summarize dcount\(CorrelationId\)\)/);
    expect(await renderString(p.check.workspace, { env: { AF_LOG_ANALYTICS_WORKSPACE_ID: WS } })).toBe(WS);
    expect(
      await renderString(p.check.workspace, {
        env: { AF_AVD_LOG_ANALYTICS_WORKSPACE_ID: 'avd', AF_LOG_ANALYTICS_WORKSPACE_ID: WS },
      }),
    ).toBe('avd');
    const res = await fetchFixture(`https://api.loganalytics.io/v1/workspaces/${WS}/query`, {
      method: 'POST',
      body: JSON.stringify({ query: p.check.query }),
    });
    const rows = tablesToRows(((await res.json()) as Def).tables)[0]!.rows;
    expect(rows.reduce((n, r) => n + Number(r.failures), 0)).toBe(8);
    expect(Math.max(...rows.map((r) => Number(r.failedAttempts)))).toBe(7);
  });
});

describe('Azure Virtual Desktop playbooks', () => {
  const pattern = (id: string, input: string) => new RegExp(def(id).inputs[input].pattern);

  it.each([
    // Typed since 1.1.0: a bulk action from medium risk up confirms by typing (high-risk-typed-confirm.test.ts).
    ['avd.set-drain-mode', 'medium', 'typed'],
    ['avd.log-off-user-session', 'high', 'typed'],
    ['avd.send-user-message', 'low', 'click'],
  ])('%s is a confirmed, Operator-only %s-risk write through Azure Resource Manager', (id, risk, confirm) => {
    const p = def(id);
    expect(p).toMatchObject({ kind: 'playbook', mode: 'write', risk, confirm: { type: confirm } });
    expect(p.requires).toMatchObject({
      portalRoles: ['Portal.Operator'],
      scopes: { arm: ['user_impersonation'] },
    });
    // Read first, check the resource type, then exactly one write.
    expect(p.steps[0]).toMatchObject({ type: 'arm', mode: 'read' });
    expect(p.steps[1]).toMatchObject({ type: 'assert' });
    expect(p.steps.filter((s: Def) => s.mode === 'write')).toHaveLength(1);
  });

  it.each(['avd.log-off-user-session', 'avd.send-user-message'])(
    '%s acts only on the session of the person the list showed (session numbers are reused)',
    (id) => {
      const p = def(id);
      expect(p.inputs.expectedUser).toMatchObject({ type: 'string' });
      const ids = p.steps.map((s: Def) => s.id);
      const check = p.steps.find((s: Def) => s.id === 'sameUser');
      expect(check).toMatchObject({ type: 'assert' });
      expect(check.that).toMatch(/userPrincipalName.*inputs\.expectedUser/);
      const write = p.steps.findIndex((s: Def) => s.mode === 'write');
      expect(ids.indexOf('sameUser')).toBeLessThan(write);
      const schema = inputsSchema(p.inputs);
      const base = {
        userSessionId: SESSION,
        title: 'Maintenance',
        message: 'Save your work.',
        reason: 'ticket 1',
      };
      expect(schema.safeParse({ ...base, expectedUser: 'm.chen@example.com' }).success).toBe(true);
      expect(schema.safeParse({ ...base, expectedUser: 'not a upn' }).success).toBe(false);
    },
  );

  it('signing out asks for the person’s sign-in name', () => {
    expect(def('avd.log-off-user-session').confirm).toMatchObject({
      type: 'typed',
      value: expect.stringContaining('steps.lookup.output.properties.userPrincipalName'),
    });
  });

  it('take session host ids in any casing Azure returns, and nothing else', () => {
    const host = pattern('avd.set-drain-mode', 'sessionHostId');
    expect(host.test(HOST)).toBe(true);
    expect(host.test(HOST.toLowerCase())).toBe(true);
    expect(host.test(POOL)).toBe(false);
    expect(host.test(`${HOST}/userSessions/3`)).toBe(false);
    expect(host.test(`${POOL}/sessionHosts/../../x`)).toBe(false);
    expect(host.test(`${HOST}?api-version=1`)).toBe(false);
    expect(host.test(HOST.replace('Microsoft.DesktopVirtualization', 'Microsoft.Compute'))).toBe(false);
    for (const id of ['avd.log-off-user-session', 'avd.send-user-message']) {
      const session = pattern(id, 'userSessionId');
      expect(session.test(SESSION)).toBe(true);
      expect(session.test(SESSION.toLowerCase())).toBe(true);
      expect(session.test(HOST)).toBe(false);
      expect(session.test(`${SESSION}/sendMessage`)).toBe(false);
      expect(session.test(`${HOST}/userSessions/3%2F..`)).toBe(false);
    }
  });

  it('cap the message a user sees', () => {
    const schema = inputsSchema(def('avd.send-user-message').inputs);
    const who = { userSessionId: SESSION, expectedUser: 'm.chen@example.com' };
    expect(
      schema.safeParse({ ...who, title: 'Planned maintenance', message: 'Save your work.' }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...who, title: 'x'.repeat(101), message: 'Save your work.' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...who, title: 'Maintenance', message: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('are wired into the pages and reports with the inputs each one needs, at most 500 at a time', () => {
    const inputOf: Record<string, string[]> = {
      'avd.set-drain-mode': ['sessionHostId'],
      'avd.log-off-user-session': ['userSessionId', 'expectedUser'],
      'avd.send-user-message': ['userSessionId', 'expectedUser'],
    };
    const used = new Set<string>();
    const walk = (node: Def) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (typeof node.playbook === 'string' && PLAYBOOKS.includes(node.playbook)) {
        used.add(node.playbook);
        const inputs = node.forEach?.inputs ?? node.inputs;
        expect([node.playbook, Object.keys(inputs)]).toEqual([
          node.playbook,
          expect.arrayContaining(inputOf[node.playbook]!),
        ]);
        if (inputs.expectedUser) expect(inputs.expectedUser).toBe('${ row.properties.userPrincipalName }');
        if (node.forEach) expect(node.maxItems).toBeLessThanOrEqual(500);
      }
      Object.values(node).forEach(walk);
    };
    VIEWS.forEach((id) => walk(def(id)));
    expect([...used].sort()).toEqual([...PLAYBOOKS].sort());
  });

  it('link rows to their host pool and session host by the ids Azure gives them', async () => {
    const hostsTable = def('avd.session-hosts').layout.find((b: Def) => b.id === 'hosts');
    const href = hostsTable.rowActions.find((a: Def) => a.label === 'User sessions on this host').href;
    const out = (await renderString(href, {
      row: { id: HOST, sessionHost: 'avd-ex-0001.example.com' },
    })) as string;
    const url = new URL(out, 'https://portal.example.com');
    expect(url.searchParams.get('hostPoolId')).toBe(POOL);
    expect(url.searchParams.get('sessionHost')).toBe('avd-ex-0001.example.com');
    const sessions = def('avd.user-sessions').layout.find((b: Def) => b.id === 'sessions');
    const toHost = sessions.rowActions.find((a: Def) => a.label === 'Session host').href;
    const hostUrl = new URL(
      (await renderString(toHost, { row: { id: SESSION } })) as string,
      'https://portal.example.com',
    );
    expect(hostUrl.searchParams.get('id')).toBe(HOST);
  });
});

describe('Azure Virtual Desktop transforms at fleet size', () => {
  // One untimed run first (compiling and warming up, as the API does once per definition), then the real budget.
  const timed = async (expr: string, scope: Record<string, unknown>) => {
    const full = { now: NOW, user: {}, env: {}, params: {}, ...scope };
    await renderString(expr, full, { timeoutMs: 30_000 }).catch(() => undefined);
    return renderString(expr, full) as Promise<Def>;
  };

  it('counts 10,000 user sessions of one host pool natively', async () => {
    const value = Array.from({ length: 10_000 }, (_, i) => ({
      id: `${POOL}/sessionHosts/avd-${i % 400}.example.com/userSessions/${i}`,
      name: `hp-example-pooled/avd-${i % 400}.example.com/${i}`,
      properties: {
        userPrincipalName: `user${i}@example.com`,
        sessionState: i % 3 ? 'Active' : 'Disconnected',
      },
    }));
    const out = await timed(def('avd.user-sessions').datasources.counts.transform, {
      ds: { sessions: { value, truncated: true } },
    });
    expect(out).toEqual({ total: 10_000, active: 6666, disconnected: 3334, partial: true });
  });

  it('classifies 5,000 host pools and adds up their slots', async () => {
    const capacities = ['NoHost', 'Full', 'NearlyFull', 'Ok', 'AllAssigned'];
    const value = Array.from({ length: 5000 }, (_, i) => ({
      id: `/subscriptions/${S1}/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/hp-${i}`,
      name: `hp-${i}`,
      capacity: capacities[i % 5],
      sessions: 10,
      freeSlots: i % 5 === 4 ? null : 2,
    }));
    const out = await timed(def('avd.host-pool-capacity').datasources.pools.transform, { value: { value } });
    expect(out).toMatchObject({
      pools: 5000,
      noHost: 1000,
      full: 1000,
      nearlyFull: 1000,
      sessions: 50_000,
      freeSlots: 8000,
    });
  });
});
