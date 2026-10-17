import path from 'node:path';
import { resolveParams } from '@adminforge/api/src/datasources/params';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString, renderTemplate } from '@adminforge/expressions';
import { loadContentDir, startsWithUnion } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Hybrid Azure Arc servers at fleet size (thousands of machines): the fleet dashboard, the server list, extensions,
// Update Manager patching and Defender for Servers coverage, the entity page's Updates and Defender tabs, the Arc
// configuration checks, and the retired Function App and Arc Kubernetes content. Each datasource runs the way
// DATA_MODE=fixtures runs it: params resolved with their defaults, the query rendered, the fixture answered, then the
// transform — with earlier datasources available as ds.<name>.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const fetchFixture = createFixtureFetch(path.join(repoRoot, 'tests/fixtures'));
const NOW = '2026-10-15T12:00:00Z';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const user = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const env = { AF_SUBSCRIPTION_ID: S1 };
const MACHINE = `/subscriptions/${S1}/resourceGroups/rg-example-arc/providers/Microsoft.HybridCompute/machines/srv-example-01`;

const LISTS: Array<[string, string]> = [
  ['azure.arc-servers', 'machines'],
  ['azure.arc-extensions', 'extensions'],
  ['azure.arc-patching', 'machines'],
  ['azure.arc-defender-coverage', 'machines'],
];
const ARC = [
  'azure.arc-fleet',
  ...LISTS.map(([id]) => id),
  'azure.arc-server',
  'azure.arc-disconnected',
  'azure.arc-agent-health',
];
const PROBES = [
  'probes.arc-machines-disconnected',
  'probes.arc-extensions-failed',
  'probes.arc-critical-updates-overdue',
  'probes.arc-not-assessed',
  'probes.arc-agents-outdated',
];

const params = (id: string, input: Record<string, unknown> = {}) =>
  resolveParams(def(id).params ?? {}, input, { env, now: NOW, user } as never);
const query = async (id: string, ds: string, input: Record<string, unknown> = {}) =>
  (await renderString(def(id).datasources[ds].query, {
    params: await params(id, input),
    env,
    now: NOW,
    user,
  })) as string;

async function resourceGraph(q: string) {
  const res = await fetchFixture(
    'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
    {
      method: 'POST',
      body: JSON.stringify({ query: q, options: { resultFormat: 'objectArray', $top: 1000 } }),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown[]; totalRecords: number };
  return { value: body.data, totalRecords: body.totalRecords };
}

/** Runs every datasource of a definition in order, against the fixtures. */
async function run(id: string, input: Record<string, unknown> = {}) {
  const p = await params(id, input);
  const ds: Record<string, Def> = {};
  for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
    const scope = { params: p, env, now: NOW, user, ds };
    const value =
      d.source === 'resourceGraph'
        ? await resourceGraph((await renderString(d.query, scope)) as string)
        : await renderTemplate(d.data, scope);
    ds[name] = d.transform ? await renderString(d.transform, { ...scope, value }) : value;
  }
  return ds;
}

const blocks = (node: unknown, out: Def[] = []): Def[] => {
  if (Array.isArray(node)) for (const n of node) blocks(n, out);
  else if (node && typeof node === 'object') {
    if ('widget' in node) out.push(node);
    for (const v of Object.values(node)) blocks(v, out);
  }
  return out;
};

describe('Azure Arc at fleet size: shape', () => {
  it.each(LISTS)('%s lists %s one page at a time in Resource Graph, with no transform', (id, ds) => {
    const d = def(id).datasources[ds];
    expect(d).toMatchObject({ source: 'resourceGraph', paging: 'cursor' });
    expect(d.transform).toBeUndefined();
    expect(def(id).export).toMatchObject({ data: `${ds}.value`, maxRows: 100000 });
    // The KPIs are counted in Resource Graph, never from the rows.
    for (const kpi of blocks(def(id).layout).filter((b) => b.widget === 'kpi'))
      expect([id, kpi.data]).toEqual([
        id,
        expect.not.stringMatching(new RegExp(`^${ds}\\.(?!totalRecords$)`)),
      ]);
  });

  it('patching lists the servers not assessed in 3 days separately, also paged with no transform', () => {
    const d = def('azure.arc-patching').datasources;
    expect(d.unassessed).toMatchObject({ source: 'resourceGraph', paging: 'cursor' });
    expect(d.unassessed.transform).toBeUndefined();
    // Resource Graph allows one join to another table per query: assessed servers join installations, the rest join
    // assessments; the KPIs count each side on its own.
    expect(d.machines.query).toMatch(/^\s*\/\/ af:[^\n]+\n\s*patchassessmentresources\n/);
    expect(d.machines.query).toContain('join kind=leftouter (patchinstallationresources');
    expect(d.machines.query).not.toContain('resourcecontainers');
    expect(d.unassessed.query).toContain('join kind=leftouter (patchassessmentresources');
  });

  it('Defender coverage reads each subscription’s plan once and passes it on as id lists', () => {
    const d = def('azure.arc-defender-coverage').datasources;
    expect(Object.keys(d)).toEqual(['plans', 'machines', 'summary']);
    for (const ds of ['machines', 'summary']) {
      expect(d[ds].query).toContain('$list(ds.plans.on)');
      expect((d[ds].query.match(/join kind=leftouter \(securityresources/g) ?? []).length).toBe(1);
    }
  });

  it('the Arc reports keep their rows without a transform and count in Resource Graph', () => {
    for (const id of ['azure.arc-disconnected', 'azure.arc-agent-health']) {
      expect(def(id).datasources.machines.transform).toBeUndefined();
      expect(def(id).datasources.summary.source).toBe('resourceGraph');
      expect(def(id).export.data).toBe('machines.value');
    }
  });

  it.each(ARC)('%s sends Resource Graph only queries it accepts', async (id) => {
    const tags = new Set<string>();
    const inputs: Array<Record<string, unknown>> = [{}];
    if (def(id).params?.subscriptionId) inputs.push({ subscriptionId: S1 });
    if (def(id).params?.id) inputs.splice(0, 1, { id: MACHINE });
    for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
      if (d.source !== 'resourceGraph') continue;
      const tag = String(d.query).split('\n')[0] ?? '';
      expect(tag).toMatch(new RegExp(`^// af:${id.replace('.', '\\.')}#[a-z]+$`));
      expect(tags.has(tag)).toBe(false);
      tags.add(tag);
      for (const input of inputs) {
        const q = await query(id, name, input);
        expect(startsWithUnion(q)).toBe(false);
        expect([id, name, (q.match(/\|\s*join\b/g) ?? []).length <= 3]).toEqual([id, name, true]);
        expect(q).not.toMatch(/kind\s*=\s*(leftanti|leftsemi|rightanti|rightsemi)/i);
        expect(q).not.toMatch(/(^|\n)\s*let\s/);
        expect(q).not.toContain('${');
      }
    }
  });

  it('every Arc view is in the Azure section and reads with Reader', () => {
    for (const id of ['azure.arc-fleet', ...LISTS.map(([i]) => i)]) {
      expect(def(id).nav.section).toBe('azure');
      expect(def(id).requires).toMatchObject({ portalRoles: ['Portal.Reader'], azureRoles: ['Reader'] });
    }
  });
});

describe('Azure Arc filters', () => {
  it('apply server-side, only from the allowed values', async () => {
    expect(await query('azure.arc-servers', 'machines', { status: 'NotConnected' })).toContain(
      "| where status != 'Connected'",
    );
    expect(await query('azure.arc-servers', 'machines', { status: 'Expired' })).toContain(
      "| where status == 'Expired'",
    );
    expect(await query('azure.arc-servers', 'machines', { agent: 'outdated' })).toContain(
      "| where agentCurrency == 'outdated'",
    );
    expect(await query('azure.arc-servers', 'machines', { esu: 'Unlicensed' })).toContain(
      "esuEligibility =~ 'Eligible' and esuLicence !~ 'Assigned'",
    );
    expect(await query('azure.arc-servers', 'machines', { extensions: 'Failed' })).toContain(
      '| where failedExtensions > 0',
    );
    expect(await query('azure.arc-extensions', 'extensions')).toContain("| where health != 'Healthy'");
    expect(await query('azure.arc-extensions', 'extensions', { state: 'All' })).not.toContain('where health');
    expect(await query('azure.arc-patching', 'machines', { state: 'Overdue' })).toContain(
      "| where patchState == 'Overdue'",
    );
    expect(await query('azure.arc-defender-coverage', 'machines')).toContain(
      "| where coverage != 'Protected'",
    );
    expect(await query('azure.arc-patching', 'unassessed', { machineStatus: 'Connected' })).toContain(
      "| where status == 'Connected'",
    );
    expect(def('azure.arc-patching').datasources.machines.when).toBe("${ params.state != 'NotAssessed' }");
    await expect(params('azure.arc-servers', { status: "Connected' or 1 == 1 //" })).rejects.toThrow();
    await expect(params('azure.arc-patching', { state: 'x' })).rejects.toThrow();
  });

  it('pass free text to KQL only as quoted literals ($kql)', async () => {
    const q = await query('azure.arc-servers', 'machines', {
      q: 'srv\' | union (resources) "x" //',
      resourceGroup: "rg'; drop",
      location: "West Europe'",
    });
    expect(q).toContain('| where name contains "srv\' | union (resources) \\"x\\" //"');
    expect(q).toContain('| where resourceGroup =~ "rg\'; drop"');
    expect(q).toContain('| where location =~ "westeurope\'"');
    const ext = await query('azure.arc-extensions', 'extensions', { extension: "AMA' or 1==1" });
    expect(ext).toContain('| where extensionType contains "AMA\' or 1==1" or name contains "AMA\' or 1==1"');
    for (const [id, ds] of LISTS) {
      const rendered = await query(id, ds, { q: 'a"b' });
      expect([id, rendered]).toEqual([id, expect.stringContaining('contains "a\\"b"')]);
    }
  });

  it('the server page reads only that machine, and its subscription for the Defender plan', async () => {
    const id = `${MACHINE}"|`;
    await expect(params('azure.arc-server', { id })).resolves.toBeDefined();
    for (const ds of ['machine', 'extensions', 'assessment', 'updates', 'installs', 'recommendations']) {
      const q = await query('azure.arc-server', ds, { id });
      expect(q).toContain(`"${MACHINE.toLowerCase()}\\"|"`);
      expect(q).not.toMatch(/[^\\]"\|/);
    }
    expect(await query('azure.arc-server', 'defenderPlan', { id: MACHINE })).toContain(
      `strcat('/subscriptions/', '${S1}', '/providers/microsoft.security/pricings/virtualmachines')`,
    );
  });
});

describe('Azure Arc views render their fixtures', () => {
  it('the fleet dashboard counts the fleet and links every number to the list behind it', async () => {
    const ds = await run('azure.arc-fleet');
    expect(ds.counts).toMatchObject({
      total: 7,
      connected: 4,
      notConnected: 3,
      expired: 1,
      outdatedAgents: 2,
    });
    expect(ds.byStatus).toEqual([
      { status: 'Connected', machines: 4 },
      { status: 'Not connected', machines: 2 },
      { status: 'Expired', machines: 1 },
    ]);
    expect(ds.patching).toEqual({ overdue: 1, pending: 2, installFailed: 2 });
    expect(ds.assessment).toEqual({ notAssessedConnected: 1 });
    expect(ds.counts.offline30).toBe(1);
    expect(ds.defender).toEqual({ protected: 3, gaps: 4 });
    expect(ds.byRegion.map((r: Def) => r.location)).toEqual(['westeurope', 'northeurope']);
    // "Offline 30+ days" counts what its link lists: not connected for at least 720 hours, Expired included.
    const kpis = blocks(def('azure.arc-fleet').layout).filter((b) => b.widget === 'kpi');
    expect(kpis.find((k) => k.data === 'counts.offline30')?.href).toBe('/p/azure.arc-disconnected?hours=720');
    expect(def('azure.arc-fleet').datasources.counts.query).toContain(
      "offline30 = countif(status != 'Connected' and datetime_diff('hour', now(), lastStatusChange) >= 720)",
    );
    expect(kpis.find((k) => k.data === 'counts.failedExtensions')?.href).toBe(
      '/p/azure.arc-servers?extensions=Failed',
    );
    const hrefs = blocks(def('azure.arc-fleet').layout)
      .filter((b) => b.widget === 'kpi')
      .map((b) => b.href);
    expect(hrefs.every((h: string) => typeof h === 'string' && h.startsWith('/p/azure.arc-'))).toBe(true);
  });

  it('an empty fleet shows zeros, not blanks', async () => {
    const t = def('azure.arc-fleet').datasources.counts.transform;
    expect(await renderString(t, { value: { value: [] } })).toMatchObject({ total: 0, notConnected: 0 });
    const s = def('azure.arc-fleet').datasources.byStatus.transform;
    expect(await renderString(s, { ds: { counts: { connected: 0, notConnected: 0, expired: 0 } } })).toEqual(
      [],
    );
  });

  it('lists come back as Resource Graph sends them', async () => {
    const servers = await run('azure.arc-servers');
    expect(servers.machines.totalRecords).toBe(7);
    expect(servers.summary).toMatchObject({ total: 7, notConnected: 3, failedExtensions: 3 });
    const ext = await run('azure.arc-extensions');
    expect(ext.extensions.value.map((r: Def) => r.health)).toEqual([
      'Failed',
      'Failed',
      'Failed',
      'In progress',
    ]);
    expect(ext.byType).toEqual([
      { extensionType: 'AzureMonitorLinuxAgent', failed: 2 },
      { extensionType: 'MDE.Windows', failed: 1 },
    ]);
    const patching = await run('azure.arc-patching');
    expect(patching.machines.value[0]).toMatchObject({ name: 'srv-example-03', patchState: 'Overdue' });
    expect(patching.machines.value.map((r: Def) => r.patchState)).not.toContain('Not assessed');
    expect(patching.unassessed.value.map((r: Def) => [r.name, r.status])).toEqual([
      ['srv-example-02', 'Disconnected'],
      ['srv-example-04', 'Expired'],
      ['srv-example-07', 'Connected'],
    ]);
    expect(patching.summary).toMatchObject({ assessed: 4, overdue: 1, pending: 2, installFailed: 2 });
    expect(patching.coverage).toEqual({ machines: 7, notAssessed: 3, notAssessedConnected: 1 });
    expect(patching.topUpdates.value).toHaveLength(4);
    const coverage = await run('azure.arc-defender-coverage');
    expect(coverage.plans).toEqual({
      p2: [S1],
      p1: [],
      on: [],
      off: ['00000000-0000-4000-8000-0000000000a2'],
    });
    const machinesQuery = await renderString(def('azure.arc-defender-coverage').datasources.machines.query, {
      params: await params('azure.arc-defender-coverage'),
      env,
      now: NOW,
      user,
      ds: { plans: coverage.plans },
    });
    expect(machinesQuery).toContain(
      `| extend plan = case(subscriptionId in~ ('00000000-0000-0000-0000-000000000000', '${S1}'), 'On (P2)'`,
    );
    expect(coverage.machines.value.map((r: Def) => r.coverage)).toEqual([
      'Sensor failed',
      'Sensor missing',
      'Sensor missing',
      'Plan off',
    ]);
  });

  it('every status in a table hits its map (no raw value shown as text)', async () => {
    for (const [id] of LISTS) {
      const ds = await run(id);
      for (const t of blocks(def(id).layout).filter((b) => b.widget === 'table')) {
        const rows = (t.data as string).split('.').reduce<Def>((o, k) => o?.[k], ds) as Def[];
        for (const col of (t.columns as Def[]).filter((c) => c.kind === 'status'))
          for (const r of rows)
            expect([id, col.field, r[col.field] in col.map]).toEqual([id, col.field, true]);
      }
    }
  });

  it('the server page shows Update Manager and Defender for its machine', async () => {
    const ds = await run('azure.arc-server', { id: MACHINE });
    expect(ds.machine).toMatchObject({ name: 'srv-example-01', autoUpgrade: 'On' });
    expect(ds.assessment).toMatchObject({ critical: 0, security: 2, rebootPending: 'false' });
    expect(ds.updates.value[0].classifications).toEqual(['Security']);
    expect(ds.installs.value.map((r: Def) => r.status)).toEqual(['Succeeded', 'CompletedWithWarnings']);
    expect(ds.defenderPlan).toEqual({ plan: 'On', subPlan: 'P2' });
    expect(
      await renderString(def('azure.arc-server').datasources.defenderPlan.transform, {
        value: { value: [] },
      }),
    ).toEqual({
      plan: 'Unknown',
    });
    const tabs = def('azure.arc-server').tabs.map((t: Def) => t.id);
    expect(tabs).toEqual(['overview', 'extensions', 'updates', 'defender', 'errors']);
  });

  it('the disconnected report counts in Resource Graph', async () => {
    const ds = await run('azure.arc-disconnected');
    expect(ds.summary).toEqual({ total: 3, expired: 1, expiringSoon: 0, error: 1 });
    expect(ds.machines.value).toHaveLength(3);
  });
});

describe('Azure Arc configuration checks', () => {
  it.each(PROBES)('%s says what it found, what to do and where', async (id) => {
    const p = def(id);
    expect(p).toMatchObject({
      group: 'azure',
      check: { kind: 'kql', source: 'resourceGraph', metric: 'rowCount' },
    });
    expect(p.tags).toEqual(expect.arrayContaining(['config-check', 'arc']));
    expect(p.remedy.length).toBeGreaterThan(100);
    const key = /^\/p\/([^?]+)/.exec(p.link.href)?.[1];
    expect(loaded.definitions.some((d) => d.def.id === key && d.def.status !== 'retired')).toBe(true);
    expect(p.check.detailsLimit).toBeGreaterThanOrEqual(100);
    // The rows an engineer reads on Synthetic monitoring start with the server's name, then why it is listed.
    const { value } = await resourceGraph(p.check.query);
    expect(value.length).toBeGreaterThan(0);
    expect(Object.keys(value[0] as object)[0]).toBe('name');
    expect(p.check.query).toMatch(/\| project name, /);
  });

  it('disconnected servers get an hour before they count (restarts and patch reboots)', () => {
    expect(def('probes.arc-machines-disconnected').check.query).toContain(
      "(status =~ 'Disconnected' and lastStatusChange < ago(1h))",
    );
  });
});

describe('Function Apps and Arc Kubernetes are retired', () => {
  const RETIRED = [
    'azure.function-apps',
    'azure.function-app',
    'azure.function-apps-without-auth',
    'reports.function-apps-without-auth-weekly',
    'azure.function-app-incident-triage',
    'azure.sync-function-triggers',
    'probes.function-hr-sync-health',
    'integrations.hr-sync',
    'azure.arc-kubernetes',
  ];

  it.each(RETIRED)('%s is retired (kept for run and audit history)', (id) => {
    expect(def(id).status).toBe('retired');
    expect(def(id).summary).toMatch(/^Retired — /);
  });

  it('their weekly schedule no longer runs', () => {
    expect(def('reports.function-apps-without-auth-weekly').enabled).toBe(false);
  });

  it('nothing active reads Arc-enabled Kubernetes or links to the Function App views', () => {
    const active = loaded.definitions.filter((d) => d.def.status !== 'retired');
    const text = (d: Def) => JSON.stringify(d.def).toLowerCase();
    expect(
      active.filter((d) => text(d).includes('microsoft.kubernetes/connectedclusters')).map((d) => d.file),
    ).toEqual([]);
    expect(
      active.filter((d) => /functionapplogs|azure\.function-app/.test(text(d))).map((d) => d.file),
    ).toEqual([]);
  });

  it('the Azure overview counts Arc servers instead of Function Apps', async () => {
    const counts = (await run('azure.overview')).counts;
    expect(counts).toMatchObject({ arcServers: 7, arcDisconnected: 3 });
    expect(counts).not.toHaveProperty('functionApps');
  });
});
