import path from 'node:path';
import { AUTOMATION_GRAPH_ROLES } from '@adminforge/cli/src/provision/catalog';
import { resolveParams } from '@adminforge/api/src/datasources/params';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString, renderTemplate } from '@adminforge/expressions';
import { loadContentDir, startsWithUnion, validateCron } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The Azure report library (portal/content/reports/azure), its schedules and KQL probes. Cost (azure.monthly-cost) is
// tested with Azure Billing (billing-library.test.ts). Each datasource runs the way
// DATA_MODE=fixtures runs it: params resolved with their defaults, the request rendered, the fixture answered, then
// the transform — with earlier datasources available as ds.<name>.

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
const S2 = '00000000-0000-4000-8000-0000000000a2';
const user = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const env = { AF_SUBSCRIPTION_ID: S1 };

const REPORTS = [
  'azure.orphaned-resources',
  'azure.budgets',
  'azure.storage-account-security',
  'azure.databases-public-access',
  'azure.vms-without-backup',
  'azure.key-vault-configuration',
  'azure.defender-plan-coverage',
  'azure.privileged-rbac-assignments',
  'azure.orphaned-role-assignments',
  'azure.custom-role-risks',
  'azure.advisor-recommendations',
  'azure.policy-compliance',
  'azure.arc-agent-health',
  'azure.app-service-security',
];
const PROBES = [
  'probes.unattached-disks-30-days',
  'probes.vms-without-backup',
  'probes.privileged-rbac-direct-users',
  'probes.custom-roles-wildcard',
  'probes.databases-public-network-access',
];

async function params(id: string, input: Record<string, unknown> = {}) {
  return resolveParams(def(id).params, input, { env, now: NOW, user } as never);
}

/** Renders a Resource Graph query with the given (already resolved) params. */
async function query(id: string, ds: string, p: Record<string, unknown>) {
  return (await renderString(def(id).datasources[ds].query, { params: p, env, now: NOW, user })) as string;
}

/** Runs every datasource of a report in order, against the fixtures; returns results by name plus the requests. */
async function run(id: string, input: Record<string, unknown> = {}, now = NOW) {
  const p = await resolveParams(def(id).params, input, { env, now, user } as never);
  const ds: Record<string, Def> = {};
  const requests: Record<string, Def> = {};
  for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
    const scope = { params: p, env, now, user, ds };
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
        {
          method: 'POST',
          body: JSON.stringify({ query: q, options: { resultFormat: 'objectArray', $top: 1000 } }),
        },
      );
      expect([id, name, res.status]).toEqual([id, name, 200]);
      const body = (await res.json()) as { data: unknown[]; totalRecords: number };
      value = { value: body.data, totalRecords: body.totalRecords };
    } else if (d.source === 'arm' || d.source === 'graph') {
      const req = await renderTemplate<Def>(d.request, scope);
      requests[name] = req;
      const qs = new URLSearchParams(d.source === 'arm' ? { 'api-version': req.apiVersion } : {});
      for (const [k, v] of Object.entries<Def>(req.query ?? {})) qs.set(k, String(v));
      const base = d.source === 'arm' ? 'https://management.azure.com' : 'https://graph.microsoft.com/v1.0';
      const res = await fetchFixture(`${base}${req.path}?${qs}`, {
        method: req.method ?? 'GET',
        ...(req.body ? { body: JSON.stringify(req.body) } : {}),
      });
      expect([id, name, res.status]).toEqual([id, name, 200]);
      value = await res.json();
    } else value = await renderTemplate(d.data, scope);
    ds[name] = d.transform ? await renderString(d.transform, { ...scope, value }) : value;
  }
  return { ds, requests, params: p };
}

describe('Azure report library: shape', () => {
  it.each(REPORTS)('%s is a Reader report with nav, export, Reader access and a schedule', (id) => {
    const r = def(id);
    expect(r.kind).toBe('report');
    expect(r.nav).toMatchObject({ section: 'reports' });
    expect(r.requires.portalRoles).toEqual(['Portal.Reader']);
    expect(r.requires.scopes.arm).toEqual(['user_impersonation']);
    expect(r.requires.azureRoles?.length).toBeGreaterThan(0);
    expect(r.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
    const tables = r.layout.filter((b: Def) => b.widget === 'table').map((b: Def) => b.data);
    expect(tables).toContain(r.export.data);
    const scheduled = loaded.definitions.filter(
      (d) =>
        d.def.kind === 'schedule' && (d.def as Def).job.kind === 'report' && (d.def as Def).job.ref === id,
    );
    expect(scheduled).toHaveLength(1);
  });

  it.each(REPORTS)('%s sends Resource Graph only queries it accepts', async (id) => {
    const tags = new Set<string>();
    for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
      if (d.source !== 'resourceGraph') continue;
      // Fixtures pick their variant by this first line, so it is unique per datasource.
      const tag = String(d.query).split('\n')[0] ?? '';
      expect(tag).toMatch(new RegExp(`^// af:${id.replace('.', '\\.')}#[a-z]+$`));
      expect(tags.has(tag)).toBe(false);
      tags.add(tag);
      for (const input of [{}, { subscriptionId: S1 }]) {
        if (input.subscriptionId && !def(id).params?.subscriptionId) continue;
        const q = await query(id, name, await params(id, input));
        expect(startsWithUnion(q)).toBe(false);
        // Resource Graph: at most three joins, no leftanti/semi flavours, no let statements.
        expect([id, name, (q.match(/\|\s*join\b/g) ?? []).length <= 3]).toEqual([id, name, true]);
        expect(q).not.toMatch(/kind\s*=\s*(leftanti|leftsemi|rightanti|rightsemi|leftantisemi)/i);
        expect(q).not.toMatch(/(^|\n)\s*let\s/);
        if (input.subscriptionId) expect(q).toContain(`subscriptionId == '${S1}'`);
      }
      // Resource Graph returns computed booleans as 1/0: transforms compare flags as 'true'/'false' text instead.
      expect([id, name, /[!=]=?\s*(true|false)\b/.test(d.transform ?? '')]).toEqual([id, name, false]);
    }
  });

  it.each([
    ['azure.orphaned-resources', 'orphans'],
    ['azure.storage-account-security', 'accounts'],
    ['azure.databases-public-access', 'servers'],
    ['azure.key-vault-configuration', 'vaults'],
    ['azure.advisor-recommendations', 'recommendations'],
    ['azure.policy-compliance', 'policies'],
    ['azure.arc-agent-health', 'machines'],
    ['azure.orphaned-role-assignments', 'orphans'],
  ])('%s keeps its rows untransformed (large tenants, streamed export); KPIs come from KQL', (id, ds) => {
    const r = def(id);
    expect(r.datasources[ds].transform).toBeUndefined();
    expect(r.export.data).toBe(`${ds}.value`);
    for (const k of r.layout.filter((b: Def) => b.widget === 'kpi'))
      expect([k.data, k.data.startsWith(`${ds}.`) && k.data !== `${ds}.totalRecords`]).toEqual([
        k.data,
        false,
      ]);
  });

  // Rows that already join another table (Recovery Services, App Service configuration) can't also join
  // resourcecontainers: Resource Graph allows one cross-table join. Their subscription names come from a small lookup
  // joined natively ($attach) — the only transform, so the export is complete up to maxItems, though not streamed.
  it.each([
    ['azure.vms-without-backup', 'vms'],
    ['azure.app-service-security', 'apps'],
  ])('%s names subscriptions with a native lookup only; KPIs come from KQL', async (id, ds) => {
    const r = def(id);
    expect(r.datasources[ds].transform).toBe(
      "${ value.value ? $merge([value, { 'value': $attach(value.value, 'subscriptionId', ds.subs, { 'subscriptionName': null }) }]) : value }",
    );
    expect(r.datasources.subs.query).toContain('resourcecontainers');
    expect(r.export.data).toBe(`${ds}.value`);
    for (const k of r.layout.filter((b: Def) => b.widget === 'kpi'))
      expect(k.data.startsWith(`${ds}.`)).toBe(false);
  });

  it('subscription filters only take GUIDs and enum filters only take their values', async () => {
    const p = await params('azure.orphaned-resources');
    await expect(
      query('azure.orphaned-resources', 'orphans', { ...p, subscriptionId: "x' or 1 == 1 //" }),
    ).rejects.toThrow();
    const injected = await query('azure.orphaned-resources', 'orphans', {
      ...p,
      category: "x' | project secrets",
      snapshotDays: 7,
    });
    expect(injected).not.toContain('project secrets');
    expect(injected).not.toMatch(/where category ==/);
    expect(injected).toContain('ago(90d)');
    // Values that slip past param validation never reach the query: numbers are re-checked against the allowed list.
    const arcParams = await params('azure.arc-agent-health');
    expect(await query('azure.arc-agent-health', 'machines', { ...arcParams, behind: 9 })).toContain(
      'releasesBehind >= 6',
    );
    await expect(
      query('azure.arc-agent-health', 'machines', { ...arcParams, behind: '1; drop' }),
    ).rejects.toThrow();
    await expect(params('azure.arc-agent-health', { behind: '1; drop' })).rejects.toThrow();
  });
});

describe('Azure report library: fixtures render', () => {
  it('orphaned resources: kinds, disk sizes and Premium disks on deallocated VMs', async () => {
    const { ds, requests } = await run('azure.orphaned-resources');
    expect(ds.orphans.value).toHaveLength(9);
    expect(ds.summary).toMatchObject({
      total: 9,
      unattachedDisks: 2,
      unattachedGiB: 960,
      premiumOnDeallocated: 1,
      publicIps: 1,
    });
    expect(ds.summary.byCategory).toHaveLength(7);
    expect(ds.summary.byCategory[0]).toEqual({ category: 'Unattached disk', resources: 2 });
    expect(requests.summary).toContain('| summarize resources = count()');
    expect(requests.summary).toContain('| union (resourcecontainers');
    expect(requests.orphans).toContain('ago(90d)');
    expect(requests.orphans).toContain('| union (resourcecontainers');
    const only = await query('azure.orphaned-resources', 'orphans', {
      ...(await params('azure.orphaned-resources', { category: 'Old snapshot', snapshotDays: '365' })),
    });
    expect(only).toContain("| where category == 'Old snapshot'");
    expect(only).toContain('ago(365d)');
  });

  it('budgets: over, close, forecast to overrun and ended, on the default subscription', async () => {
    const { ds, requests } = await run('azure.budgets');
    expect(requests.budgets.path).toBe(`/subscriptions/${S1}/providers/Microsoft.Consumption/budgets`);
    expect(ds.budgets).toMatchObject({ total: 4, over: 1, near: 1, forecast: 1, noAlerts: 1 });
    expect(ds.budgets.rows.map((r: Def) => [r.name, r.state])).toEqual([
      ['budget-example-data', 'Over'],
      ['budget-example-monthly', 'Near'],
      ['budget-example-fy26', 'Ended'],
      ['budget-example-sandbox', 'Forecast'],
    ]);
    expect(ds.budgets.rows[1]).toMatchObject({
      used: 0.86,
      forecastUsed: 1.12,
      currency: 'EUR',
      alerts: 2,
      thresholds: '80 % actual, 100 % forecasted',
    });
    const strict = await run('azure.budgets', { nearPercent: '90' });
    expect(strict.ds.budgets).toMatchObject({ near: 0, forecast: 2 });
  });

  it('budgets: nothing is called without a subscription', async () => {
    const r = await resolveParams(def('azure.budgets').params, {}, { env: {}, now: NOW, user } as never);
    expect(await renderString(def('azure.budgets').datasources.budgets.when, { params: r })).toBe(false);
  });

  it('storage, databases and Key Vault settings count each finding', async () => {
    expect((await run('azure.storage-account-security')).ds.summary).toEqual({
      total: 3,
      sharedKey: 3,
      allNetworks: 1,
      blobPublic: 1,
      weakTransport: 1,
    });
    const dbs = await run('azure.databases-public-access');
    expect(dbs.ds.summary).toEqual({ total: 4, public: 4, anyAddress: 1, localAuth: 3, oldTls: 1 });
    expect(dbs.ds.servers.value.map((r: Def) => r.entraOnly)).toEqual(['false', 'false', 'false', 'true']);
    expect((await run('azure.key-vault-configuration')).ds.summary).toEqual({
      total: 3,
      accessPolicies: 2,
      noPurgeProtection: 2,
      shortRetention: 1,
      allNetworks: 1,
    });
  });

  it('VMs without backup: the state filter is a whitelist', async () => {
    expect((await run('azure.vms-without-backup')).ds.summary).toEqual({
      total: 4,
      unprotected: 1,
      stopped: 1,
      failing: 2,
    });
    const q = (state: string) =>
      params('azure.vms-without-backup', { state }).then((p) => query('azure.vms-without-backup', 'vms', p));
    expect(await q('problems')).toContain("| where backup != 'Protected'");
    expect(await q('Not protected')).toContain("| where backup == 'Not protected'");
    expect(await q('any')).not.toMatch(/where backup [!=]=/);
  });

  it('Defender plan coverage: one row per subscription, gaps counted per plan', async () => {
    const c = (await run('azure.defender-plan-coverage')).ds.coverage;
    expect(c).toMatchObject({ subscriptions: 2, noCspm: 1, noServers: 1, nothingOn: 0 });
    expect(c.rows.map((r: Def) => [r.subscriptionId, r.coverage])).toEqual([
      [S2, 0.0769],
      [S1, 0.6923],
    ]);
    expect(c.byPlan.find((b: Def) => b.plan === 'Resource Manager').subscriptions).toBe(2);
    expect(c.byPlan.find((b: Def) => b.plan === 'Servers').subscriptions).toBe(1);
  });

  it('privileged role assignments: principals resolved with one getByIds, each with one finding', async () => {
    const { ds, requests } = await run('azure.privileged-rbac-assignments');
    expect(requests.principals).toMatchObject({ method: 'POST', path: '/directoryObjects/getByIds' });
    expect(requests.principals.body.ids).toHaveLength(7);
    expect(ds.principals).toMatchObject({
      total: 7,
      guests: 2,
      deleted: 1,
      root: 1,
      directUsers: 4,
      notChecked: 0,
    });
    const finding = Object.fromEntries(
      ds.principals.rows.map((r: Def) => [r.principalId.slice(-3), r.finding]),
    );
    expect(finding).toEqual({
      '301': 'Root scope',
      '302': 'Guest',
      '303': 'Deleted identity',
      '304': 'Group',
      '305': 'Service principal',
      '306': 'External account',
      '307': 'Direct user assignment',
    });
    expect(ds.principals.rows.find((r: Def) => r.principalId.endsWith('302'))).toMatchObject({
      principalName: 'Pat Partner',
      userType: 'Guest',
      principalState: 'Exists',
    });
  });

  it('privileged role assignments: a single principal is still sent as a list', async () => {
    const one = { rows: [{ principalId: '30000000-0000-4000-8000-000000000301' }] };
    const body = await renderTemplate<Def>(
      def('azure.privileged-rbac-assignments').datasources.principals.request.body,
      {
        ds: { assignments: one },
      },
    );
    expect(body.ids).toEqual(['30000000-0000-4000-8000-000000000301']);
  });

  it('role assignments to deleted identities: only principals getByIds no longer returns', async () => {
    const { ds, requests } = await run('azure.orphaned-role-assignments');
    expect(requests.found1.body.ids).toHaveLength(4);
    expect(ds.found2).toBeNull();
    expect(ds.deleted).toEqual({
      ids: ['30000000-0000-4000-8000-000000000312', '30000000-0000-4000-8000-000000000313'],
      count: 2,
      privileged: 1,
      checked: 4,
      notChecked: 0,
    });
    expect(requests.orphans).toContain(
      "| where principalId in ('30000000-0000-4000-8000-000000000312', '30000000-0000-4000-8000-000000000313')",
    );
    expect(ds.orphans.value.map((r: Def) => r.principalId.slice(-3)).sort()).toEqual(['312', '312', '313']);
  });

  // The transform must fit the 250 ms budget, measured in wall-clock time: a saturated machine (the whole suite in
  // parallel) can miss it once, a regression misses it every time — hence the retries.
  it(
    'role assignments to deleted identities: batches of 1000 principals, at most 1000 deleted per query',
    { retry: 2 },
    async () => {
      const r = def('azure.orphaned-role-assignments').datasources;
      const guid = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const principals = {
        value: Array.from({ length: 3500 }, (_, i) => ({
          principalId: guid(i),
          privilegedAssignments: i % 2,
        })),
      };
      const batch = async (n: string) =>
        (await renderTemplate<Def>(r[n].request.body, { ds: { principals } })).ids;
      expect((await batch('found1')).slice(0, 2)).toEqual([guid(0), guid(1)]);
      expect(await batch('found2')).toHaveLength(1000);
      expect((await batch('found3'))[0]).toBe(guid(2000));
      expect(await renderString(r.found3.when, { ds: { principals } })).toBe(true);
      // The whole second batch was deleted, and guid(5); guid(3000) onwards were never looked up.
      const ids = principals.value.map((x) => x.principalId);
      const t0 = performance.now();
      const deleted = (await renderString(r.deleted.transform, {
        ds: {
          principals,
          found1: ids.slice(0, 1000).filter((i) => i !== guid(5)),
          found2: null,
          found3: ids.slice(2000, 3000),
        },
      })) as Def;
      expect(performance.now() - t0).toBeLessThan(250);
      expect(deleted).toMatchObject({ count: 1001, checked: 3000, notChecked: 500, privileged: 501 });
      const q = (await renderString(r.orphans.query, {
        params: { privilegedOnly: false },
        ds: { deleted },
      })) as string;
      expect((q.match(/'30000000-0000-4000-8000-\d{12}'/g) ?? []).length).toBe(1000);
      await expect(
        renderString(r.orphans.query, { params: {}, ds: { deleted: { count: 1, ids: ["x') or true //"] } } }),
      ).rejects.toThrow();
      expect(
        await renderString(r.orphans.query, { params: {}, ds: { deleted: { count: 0, ids: [] } } }),
      ).toContain('| where 1 == 0');
    },
  );

  it('custom roles, Advisor, policy compliance, Arc and App Service summarise their rows', async () => {
    expect((await run('azure.custom-role-risks')).ds.roles).toMatchObject({
      total: 3,
      allActions: 1,
      grantsAccess: 1,
      assigned: 2,
    });
    const adv = (await run('azure.advisor-recommendations')).ds.summary;
    expect(adv).toMatchObject({ total: 5, high: 3, security: 1, savings: 4960, savingsCurrency: 'USD' });
    expect(adv.byCategory.find((c: Def) => c.category === 'Cost')).toEqual({
      category: 'Cost',
      high: 1,
      medium: 1,
      low: 0,
    });
    const pol = await run('azure.policy-compliance');
    expect(pol.ds.policies.totalRecords).toBe(3);
    expect(pol.ds.summary).toEqual({
      nonCompliantResources: 15,
      resources: 52,
      assignments: 2,
      compliance: 0.7115,
    });
    expect((await run('azure.arc-agent-health')).ds.summary).toEqual({
      total: 3,
      failedExtensions: 1,
      outdated: 1,
      noAutoUpgrade: 2,
      newest: '1.48.02881.1941',
    });
    expect((await run('azure.app-service-security')).ds.summary).toEqual({
      total: 3,
      transport: 2,
      ftp: 1,
      eol: 2,
      endingSoon: 1,
    });
  });

  it('row actions pass the row to existing playbooks', async () => {
    const table = (id: string) => def(id).layout.find((b: Def) => b.widget === 'table');
    const remove = table('azure.orphaned-role-assignments').rowActions[0];
    expect(remove.playbook).toBe('azure.remove-role-assignment');
    expect(await renderTemplate(remove.inputs, { row: { id: '/subscriptions/x/providers/a' } })).toEqual({
      assignmentId: '/subscriptions/x/providers/a',
    });
    const keep = table('azure.orphaned-resources').rowActions[0];
    expect(keep.playbook).toBe('azure.add-tags');
    expect(await renderTemplate(keep.inputs, { row: { id: '/subscriptions/x/r' } })).toEqual({
      resourceId: '/subscriptions/x/r',
      tagName: 'keep',
    });
  });
});

describe('Azure report schedules', () => {
  const schedules = loaded.definitions
    .map((d) => d.def as Def)
    .filter((d) => d.kind === 'schedule' && d.job.kind === 'report' && REPORTS.includes(d.job.ref));

  it('cover every report, run as the automation identity and keep a file plus an email', async () => {
    expect(schedules.map((s) => s.job.ref).sort()).toEqual([...REPORTS].sort());
    for (const s of schedules) {
      expect(validateCron(s.cron)).toBeUndefined();
      expect([s.id, s.identity, s.timezone, s.overlap]).toEqual([s.id, 'automation', 'UTC', 'skip']);
      expect(s.job.delivery[0]).toMatchObject({ type: 'file', format: 'xlsx' });
      expect(s.job.delivery[1]).toMatchObject({
        type: 'email',
        to: ['${ env.AF_REPORT_RECIPIENTS }'],
        format: 'xlsx',
      });
      // Pinned params must be ones the report declares, with valid values.
      await expect(
        resolveParams(def(s.job.ref).params, s.job.params, { env, now: NOW, user } as never),
      ).resolves.toBeDefined();
      const graph: string[] = s.requires?.scopes?.graph ?? [];
      for (const scope of graph) expect(AUTOMATION_GRAPH_ROLES).toContain(scope);
      expect(graph).toEqual(expect.arrayContaining(def(s.job.ref).requires.scopes.graph ?? []));
    }
  });

  it('are enabled and active (the cost report waits for its Cost Management role, in the billing area)', () => {
    for (const s of schedules)
      expect([s.job.ref, s.enabled, s.status ?? 'active']).toEqual([
        s.job.ref,
        s.job.ref !== 'azure.monthly-cost',
        'active',
      ]);
  });

  it('spread over the morning so Resource Graph is not asked everything at once', () => {
    const slots = schedules.filter((s) => s.enabled).map((s) => s.cron);
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe('Azure KQL configuration checks', () => {
  it.each(PROBES)('%s runs in the configuration sweep and keeps the offending rows', (id) => {
    const p = def(id);
    expect(p.tags).toContain('config-check');
    expect(p.check).toMatchObject({ kind: 'kql', source: 'resourceGraph', metric: 'rowCount' });
    expect(p.check.query.split('\n')[0]).toBe(`// af:${id}`);
    expect(p.check.query).not.toMatch(/(^|\n)\s*let\s/);
    expect(p.check.detailsLimit).toBeGreaterThan(0);
    expect(p.thresholds.warn).toBe(1);
    expect(p.requires.azureRoles).toEqual(['Reader']);
  });

  it.each(PROBES)('%s has a Resource Graph fixture', async (id) => {
    const res = await fetchFixture(
      'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
      { method: 'POST', body: JSON.stringify({ query: def(id).check.query }) },
    );
    const body = (await res.json()) as { data: Def[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(Object.keys(body.data[0])).toContain('id');
  });
});
