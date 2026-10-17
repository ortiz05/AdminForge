import path from 'node:path';
import { resolveParams } from '@adminforge/api/src/datasources/params';
import { composeNav } from '@adminforge/api/src/routes/nav';
import { reportArea } from '@adminforge/api/src/reports/catalog';
import { createFixtureFetch, evaluate } from '@adminforge/connectors';
import { renderString, renderTemplate } from '@adminforge/expressions';
import { loadContentDir, parseSchedule, type Navigation } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Azure Billing (portal/content/{dashboards,pages,reports,schedules}/billing plus azure.monthly-cost and azure.budgets):
// cost across every subscription from Cost Management at management-group scope (the tenant root group by default),
// a subscription or a billing account. Each datasource runs the way DATA_MODE=fixtures runs it — params resolved with
// their defaults, the request rendered, the fixture answered, then the transform — with earlier datasources as ds.<name>.

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
const TENANT = '00000000-0000-4000-8000-0000000000f0';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const MCA = '00000000-0000-4000-8000-0000000000b1:00000000-0000-4000-8000-0000000000b2_2019-05-31';
const MG_QUERY = `/providers/Microsoft.Management/managementGroups/${TENANT}/providers/Microsoft.CostManagement/query`;
const user = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const ENV = { AF_TENANT_ID: TENANT };

const REPORTS = [
  'billing.cost-analysis',
  'billing.monthly-trend',
  'billing.chargeback',
  'billing.top-resources',
  'azure.monthly-cost',
  'azure.budgets',
];
const COST_VIEWS = [...REPORTS.filter((r) => r !== 'azure.budgets'), 'billing.overview'];

/** Runs every datasource in order against the fixtures; returns results by name plus the rendered requests. */
async function run(
  id: string,
  input: Record<string, unknown> = {},
  opts: { now?: string; env?: object } = {},
) {
  const now = opts.now ?? NOW;
  const env = opts.env ?? ENV;
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
    if (d.source === 'arm') {
      const req = await renderTemplate<Def>(d.request, scope);
      requests[name] = req;
      const qs = new URLSearchParams({ 'api-version': req.apiVersion });
      for (const [k, v] of Object.entries<Def>(req.query ?? {})) qs.set(k, String(v));
      const res = await fetchFixture(`https://management.azure.com${req.path}?${qs}`, {
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

describe('Azure Billing: placement', () => {
  const records = loaded.definitions.map((d) => ({
    kind: d.def.kind,
    key: d.def.id,
    version: d.def.version,
    sha256: d.sha256,
    def: d.def,
    status: 'published',
    source: 'fs',
    file: d.file,
  }));
  const navigation = def('portal.navigation') as Navigation;

  it('the Azure Billing section shows the overview and invoices; the reports live in its catalogue area', () => {
    const nav = composeNav({
      navigation,
      definitions: records as never,
      roles: ['Portal.Reader'],
      licences: null,
    });
    const billing = nav.sections.find((s) => s.key === 'billing')!;
    expect(billing.label).toBe('Azure Billing');
    expect(billing.items.map((i) => i.href)).toEqual(
      expect.arrayContaining(['/p/billing.overview', '/p/billing.invoices']),
    );
    for (const id of REPORTS) {
      const r = def(id);
      expect([id, reportArea(id, r.area)]).toEqual([id, 'billing']);
      expect(r.nav.section).toBe('reports');
      expect(r.tags.length).toBeGreaterThan(1);
      expect(r.summary.length).toBeGreaterThan(40);
      expect(r.export.formats).toEqual(expect.arrayContaining(['csv', 'xlsx']));
      expect(r.status ?? 'active').toBe('active');
    }
  });

  it.each(COST_VIEWS)('%s reads with delegated ARM and names Cost Management Reader', (id) => {
    const d = def(id);
    expect(d.requires.portalRoles).toEqual(['Portal.Reader']);
    expect(d.requires.scopes.arm).toEqual(['user_impersonation']);
    expect(d.requires.azureRoles).toEqual(['Cost Management Reader']);
    // Cost Management throttles per scope: every query is cached for an hour.
    for (const ds of Object.values<Def>(d.datasources))
      if (ds.source === 'arm') expect([id, ds.cache?.ttl]).toEqual([id, 3600]);
  });
});

/** Only the static datasources (scope, period) and the rendered requests: nothing is fetched. */
async function plan(
  id: string,
  input: Record<string, unknown> = {},
  opts: { now?: string; env?: object } = {},
) {
  const now = opts.now ?? NOW;
  const env = opts.env ?? ENV;
  const p = await resolveParams(def(id).params, input, { env, now, user } as never);
  const ds: Record<string, Def> = {};
  const requests: Record<string, Def> = {};
  for (const [name, d] of Object.entries<Def>(def(id).datasources)) {
    const scope = { params: p, env, now, user, ds };
    if (d.source === 'static') {
      ds[name] = d.transform ? await renderString(d.transform, { ...scope, value: d.data }) : d.data;
      continue;
    }
    ds[name] = null;
    if (d.when !== undefined && (await renderString(d.when, scope)) !== true) continue;
    requests[name] = await renderTemplate<Def>(d.request, scope);
  }
  return { ds, requests, params: p };
}

describe('Azure Billing: scope', () => {
  const scopeOf = async (input: Record<string, unknown>, env: object) =>
    (await plan('billing.cost-analysis', input, { env })).ds.scope;

  it('defaults to the tenant root group, or the management group in AF_COST_MANAGEMENT_GROUP_ID', async () => {
    expect((await scopeOf({}, ENV)).path).toBe(`/providers/Microsoft.Management/managementGroups/${TENANT}`);
    const named = await plan(
      'billing.cost-analysis',
      {},
      { env: { ...ENV, AF_COST_MANAGEMENT_GROUP_ID: 'mg-example' } },
    );
    expect(named.ds.scope).toMatchObject({
      kind: 'managementGroup',
      path: '/providers/Microsoft.Management/managementGroups/mg-example',
    });
    expect(named.requests.cost.path).toBe(
      '/providers/Microsoft.Management/managementGroups/mg-example/providers/Microsoft.CostManagement/query',
    );
  });

  it('a picked subscription wins; the billing account scope encodes its id', async () => {
    expect((await scopeOf({ subscriptionId: S1 }, ENV)).path).toBe(`/subscriptions/${S1}`);
    const account = await scopeOf({ scope: 'billingAccount' }, { ...ENV, AF_BILLING_ACCOUNT_ID: MCA });
    expect(account.path).toBe(`/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(MCA)}`);
  });

  it('nothing is called without a scope, and the page says which key to set', async () => {
    const none = await plan('billing.cost-analysis', {}, { env: {} });
    expect(none.ds.scope.missing).toMatch(/AF_COST_MANAGEMENT_GROUP_ID/);
    expect(none.requests).toEqual({});
    const noAccount = await plan('billing.cost-analysis', { scope: 'billingAccount' }, { env: ENV });
    expect(noAccount.ds.scope.missing).toMatch(/AF_BILLING_ACCOUNT_ID/);
    expect(noAccount.requests).toEqual({});
  });

  it('ids that are not ids never reach a path', async () => {
    await expect(plan('billing.cost-analysis', { managementGroupId: 'mg/../x' })).rejects.toThrow();
    await expect(plan('billing.cost-analysis', { billingAccountId: 'a/b' })).rejects.toThrow();
    await expect(plan('billing.cost-analysis', { subscriptionId: "x' or 1" })).rejects.toThrow();
  });

  it.each(COST_VIEWS)('%s sends only Cost Management reads the request policy allows', async (id) => {
    const inputs = [
      {},
      { subscriptionId: S1 },
      ...(def(id).params.scope ? [{ scope: 'billingAccount' }] : []),
    ];
    for (const input of inputs) {
      const { requests } = await plan(id, input, { env: { ...ENV, AF_BILLING_ACCOUNT_ID: MCA } });
      expect(Object.keys(requests).length).toBeGreaterThan(0);
      for (const [name, req] of Object.entries<Def>(requests)) {
        const decision = evaluate('read', { service: 'arm', method: req.method ?? 'GET', path: req.path });
        expect([id, name, req.path, decision.allowed]).toEqual([id, name, req.path, true]);
        expect(req.path).toMatch(/\/providers\/Microsoft\.CostManagement\/(query|forecast)$/);
      }
    }
  });
});

describe('Azure Billing: periods', () => {
  const period = async (timeframe: string, extra: Record<string, unknown> = {}, now = NOW) =>
    (await plan('billing.cost-analysis', { timeframe, ...extra }, { now })).ds.period;

  it.each([
    ['MonthToDate', '2026-10-01T00:00:00Z', '2026-10-15T23:59:59Z'],
    ['LastMonth', '2026-09-01T00:00:00Z', '2026-09-30T23:59:59.000Z'],
    ['Last3Months', '2026-07-01T00:00:00Z', '2026-09-30T23:59:59.000Z'],
    ['Last6Months', '2026-04-01T00:00:00Z', '2026-09-30T23:59:59.000Z'],
    ['Last12Months', '2025-10-01T00:00:00Z', '2026-09-30T23:59:59.000Z'],
    ['YearToDate', '2026-01-01T00:00:00Z', '2026-10-15T23:59:59Z'],
    ['LastYear', '2025-01-01T00:00:00Z', '2025-12-31T23:59:59Z'],
    ['Last30Days', '2026-09-16T00:00:00Z', '2026-10-15T23:59:59Z'],
  ])('%s → %s … %s', async (timeframe, from, to) => {
    expect(await period(timeframe)).toMatchObject({ from, to });
  });

  it('January rolls back into last year; custom periods are checked', async () => {
    expect(await period('LastMonth', {}, '2027-01-10T08:00:00Z')).toMatchObject({
      from: '2026-12-01T00:00:00Z',
      to: '2026-12-31T23:59:59.000Z',
    });
    expect(await period('Last3Months', {}, '2027-02-01T00:00:00Z')).toMatchObject({
      from: '2026-11-01T00:00:00Z',
    });
    expect(await period('Custom', { from: '2026-08-01', to: '2026-08-31' })).toMatchObject({
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-31T23:59:59Z',
      label: '2026-08-01 to 2026-08-31',
    });
    expect((await period('Custom', { from: '2026-09-01', to: '2026-08-01' })).error).toMatch(/ends before/);
    expect((await period('Custom', { from: '2025-01-01', to: '2026-08-01' })).error).toMatch(/one year/);
    const bad = await plan('billing.cost-analysis', {
      timeframe: 'Custom',
      from: '2026-09-01',
      to: '2026-08-01',
    });
    expect(bad.requests).toEqual({});
  });
});

describe('Azure Billing: views over the fixtures', () => {
  it('cost analysis: by service across every subscription, shares and the top ten', async () => {
    const { ds, requests } = await run('billing.cost-analysis');
    expect(requests.cost).toMatchObject({
      method: 'POST',
      path: MG_QUERY,
      body: {
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-15T23:59:59Z' },
        dataset: { granularity: 'None', grouping: [{ type: 'Dimension', name: 'ServiceName' }] },
      },
    });
    expect(ds.cost).toMatchObject({
      total: 2833.51,
      currency: 'EUR',
      groups: 8,
      byPeriod: false,
      partial: false,
    });
    expect(ds.cost.rows[0]).toMatchObject({ group: 'Virtual Machines', cost: 1120.4 });
    expect(ds.cost.rows[0].share).toBeCloseTo(0.3954, 4);
    expect(ds.cost.top).toHaveLength(8);
    expect(ds.cost.trend).toEqual([]);
  });

  it('cost analysis: a second dimension, amortized cost and a tag', async () => {
    const two = await run('billing.cost-analysis', {
      timeframe: 'LastMonth',
      groupBy: 'SubscriptionName',
      thenBy: 'ServiceName',
      costType: 'AmortizedCost',
    });
    expect(two.requests.cost.body.type).toBe('AmortizedCost');
    expect(two.requests.cost.body.dataset.grouping).toEqual([
      { type: 'Dimension', name: 'SubscriptionName' },
      { type: 'Dimension', name: 'ServiceName' },
    ]);
    expect(two.ds.cost.rows[0]).toMatchObject({
      group: 'Example Org Production',
      detail: 'Virtual Machines',
      cost: 1500.4,
    });
    // Grouping by one dimension twice keeps one.
    const same = await run('billing.cost-analysis', { groupBy: 'ServiceName', thenBy: 'ServiceName' });
    expect(same.requests.cost.body.dataset.grouping).toHaveLength(1);
    const tag = await run('billing.cost-analysis', { groupBy: 'Tag', tagKey: 'Department' });
    expect(tag.requests.cost.body.dataset.grouping).toEqual([{ type: 'TagKey', name: 'Department' }]);
    expect(tag.ds.cost.rows.map((r: Def) => r.group)).toEqual([
      'CC-1001',
      'CC-2002',
      '(untagged)',
      'CC-3003',
    ]);
    // The tag key defaults to AF_COST_TAG_NAME, then CostCenter.
    const fromEnv = await run(
      'billing.cost-analysis',
      { groupBy: 'Tag' },
      { env: { ...ENV, AF_COST_TAG_NAME: 'Team' } },
    );
    expect(fromEnv.requests.cost.body.dataset.grouping[0].name).toBe('Team');
    expect((await run('billing.cost-analysis', { groupBy: 'Tag' })).params.tagKey).toBe('CostCenter');
    await expect(run('billing.cost-analysis', { groupBy: 'Tag', tagKey: 'a"b' })).rejects.toThrow();
  });

  it('cost analysis: by day, the five highest groups over time', async () => {
    const { ds, requests } = await run('billing.cost-analysis', { granularity: 'Daily' });
    expect(requests.cost.body.dataset.granularity).toBe('Daily');
    expect(ds.cost.byPeriod).toBe(true);
    expect(ds.cost.rows).toHaveLength(60);
    expect(ds.cost.rows.every((r: Def) => /^2026-10-\d\d$/.test(r.period))).toBe(true);
    expect(new Set(ds.cost.trend.map((r: Def) => r.group)).size).toBe(4);
    expect(ds.cost.trend[0].period).toBe('2026-10-01');
  });

  it('cost analysis: by resource, named by the resource with its id kept', async () => {
    const { ds } = await run('billing.cost-analysis', { groupBy: 'ResourceId' });
    expect(ds.cost.rows[0]).toMatchObject({
      group: 'vm-example-app01',
      resourceId: `/subscriptions/${S1}/resourcegroups/rg-example-app/providers/microsoft.compute/virtualmachines/vm-example-app01`,
    });
    expect(ds.cost.rows.find((r: Def) => !r.resourceId).group).toBe('(not assigned)');
  });

  it('this month and last: every subscription, projected, with links to each', async () => {
    const { ds, requests } = await run('azure.monthly-cost');
    expect(requests.monthToDate).toMatchObject({
      path: MG_QUERY,
      body: {
        timeframe: 'MonthToDate',
        dataset: {
          grouping: [
            { type: 'Dimension', name: 'SubscriptionId' },
            { type: 'Dimension', name: 'SubscriptionName' },
          ],
        },
      },
    });
    expect(requests.cost.body.timePeriod).toEqual({
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59.000Z',
    });
    expect(ds.cost).toMatchObject({ monthToDate: 2833.51, lastMonth: 3685.85, currency: 'EUR', groups: 4 });
    expect(ds.cost.rows[0]).toMatchObject({
      key: S1,
      group: 'Example Org Production',
      subscriptionId: S1,
      monthToDate: 1657.26,
      lastMonth: 2485.5,
    });
    expect(ds.cost.rows[0].change).toBeCloseTo(0.4255, 3);
    // New this month: no change to compare.
    expect(ds.cost.rows.find((r: Def) => r.group === 'Example Org Sandbox')).toMatchObject({
      lastMonth: 0,
      change: null,
    });
  });

  it('this month and last: one subscription by resource group, as before', async () => {
    const { ds, requests } = await run('azure.monthly-cost', {
      subscriptionId: S1,
      groupBy: 'ResourceGroupName',
    });
    expect(requests.monthToDate.path).toBe(`/subscriptions/${S1}/providers/Microsoft.CostManagement/query`);
    expect(requests.monthToDate.body.dataset.grouping).toEqual([
      { type: 'Dimension', name: 'ResourceGroupName' },
    ]);
    expect(ds.cost).toMatchObject({ monthToDate: 1657.26, lastMonth: 2485.5, currency: 'EUR', groups: 4 });
    expect(ds.cost.projected).toBeCloseTo(3543.11, 1);
    expect(ds.cost.rows.map((r: Def) => r.group)).toEqual([
      'rg-example-functions',
      'rg-example-data',
      '(not assigned)',
      'rg-example-old',
    ]);
    expect(ds.cost.rows[3]).toMatchObject({
      monthToDate: 0,
      lastMonth: 95.1,
      change: -1,
      subscriptionId: null,
    });
    // A single-row answer (one subscription, grouped by subscription) still makes one row.
    const single = await run('azure.monthly-cost', { subscriptionId: S1 });
    expect(single.ds.cost.rows).toHaveLength(1);
    expect(single.ds.cost.rows[0]).toMatchObject({ key: S1, monthToDate: 1657.26, lastMonth: 2485.5 });
  });

  it('monthly trend: twelve months up to this one, month-over-month per subscription', async () => {
    const { ds, requests } = await run('billing.monthly-trend');
    expect(ds.months.list).toHaveLength(12);
    expect(ds.months.list[0]).toBe('2025-11');
    expect(ds.months.list[11]).toBe('2026-10');
    expect(requests.trend.body).toMatchObject({
      timePeriod: { from: '2025-11-01T00:00:00Z', to: '2026-10-15T23:59:59Z' },
      dataset: { granularity: 'Monthly', grouping: [{ type: 'Dimension', name: 'SubscriptionName' }] },
    });
    expect(ds.trend).toMatchObject({
      lastFullMonth: 3685.85,
      monthBefore: 3380,
      currency: 'EUR',
      partial: false,
    });
    expect(ds.trend.change).toBeCloseTo(0.0905, 3);
    const prod = ds.trend.lines.find((l: Def) => l.group === 'Example Org Production');
    expect(prod).toMatchObject({ lastFullMonth: 2485.5, monthBefore: 2200, thisMonth: 1657.26 });
    expect(prod.change).toBeCloseTo(0.1298, 3);
    expect(ds.trend.lines[0].group).toBe('Example Org Production');
    expect(ds.trend.chart.every((c: Def) => /^\d{4}-\d\d$/.test(c.month))).toBe(true);
    const six = await run('billing.monthly-trend', { months: 6 });
    expect(six.ds.months.from).toBe('2026-05-01T00:00:00Z');
  });

  it('chargeback: what each tag value carries and what has no value', async () => {
    const { ds, requests } = await run('billing.chargeback');
    expect(requests.cost.body).toMatchObject({
      type: 'AmortizedCost',
      timePeriod: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59.000Z' },
      dataset: { grouping: [{ type: 'TagKey', name: 'CostCenter' }] },
    });
    expect(ds.cost).toMatchObject({ total: 2833.51, untagged: 632.76, values: 3, currency: 'EUR' });
    expect(ds.cost.allocated).toBeCloseTo(0.7767, 3);
    expect(ds.cost.rows.find((r: Def) => r.value === '(untagged)')).toMatchObject({ tagged: 'false' });
    const split = await run('billing.chargeback', { thenBy: 'SubscriptionName' });
    expect(split.ds.cost.rows[0]).toMatchObject({ value: 'CC-1001', detail: 'Example Org Production' });
    expect(split.ds.cost.top[0]).toEqual({ value: 'CC-1001', cost: 1200.5 });
  });

  it('top resources: ranked, with subscription, group and type from the id', async () => {
    const { ds, requests } = await run('billing.top-resources');
    expect(requests.cost.body.dataset.grouping).toEqual([{ type: 'Dimension', name: 'ResourceId' }]);
    expect(ds.cost.rows.map((r: Def) => r.name)).toEqual([
      'vm-example-app01',
      'sql-example-core',
      'stexampledata',
      'asp-example-api',
      'log-example',
      '(not tied to a resource)',
    ]);
    expect(ds.cost.rows[0]).toMatchObject({
      subscriptionId: S1,
      resourceGroup: 'rg-example-app',
      type: 'microsoft.compute/virtualmachines',
    });
    expect(ds.cost.rows[5]).toMatchObject({ resourceId: null, subscriptionId: null });
    expect((await run('billing.top-resources', { top: 25 })).ds.cost.rows).toHaveLength(6);
  });

  it('overview: this month, last month, the forecast and the subscriptions behind them', async () => {
    const { ds, requests } = await run('billing.overview');
    expect(requests.forecast).toMatchObject({
      path: MG_QUERY.replace(/query$/, 'forecast'),
      body: {
        timePeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59.000Z' },
        dataset: { granularity: 'Daily' },
        includeActualCost: true,
      },
    });
    // This month and last month come from one monthly query (three Cost Management queries a load with the forecast).
    expect(requests.bySubscription).toMatchObject({
      path: MG_QUERY,
      body: {
        timeframe: 'Custom',
        timePeriod: { from: '2026-09-01T00:00:00Z', to: '2026-10-15T23:59:59Z' },
        dataset: { granularity: 'Monthly' },
      },
    });
    expect(requests).not.toHaveProperty('lastMonth');
    expect(ds.forecast.days).toHaveLength(31);
    expect(ds.forecast.days[0]).toMatchObject({ day: '2026-10-01', status: 'Actual' });
    expect(ds.forecast.days[30]).toMatchObject({ day: '2026-10-31', status: 'Forecast' });
    expect(ds.summary).toMatchObject({
      monthToDate: 2833.51,
      lastMonth: 3685.85,
      projected: ds.forecast.total,
      projectedFrom: 'Cost Management forecast',
      currency: 'EUR',
      subscriptions: 4,
    });
    expect(ds.summary.change).toBeCloseTo((ds.forecast.total - 3685.85) / 3685.85, 3);
    expect(ds.summary.rows[0]).toMatchObject({ name: 'Example Org Production', subscriptionId: S1 });
    expect(ds.byService.top.map((s: Def) => s.service)).toEqual([
      'Virtual Machines',
      'Azure App Service',
      'Azure SQL Database',
      'Storage',
      'Azure Monitor',
      'Other',
    ]);
    expect(ds.byService.top[5].cost).toBe(105);
  });

  it('overview: a straight-line projection when no forecast comes back', async () => {
    const t = def('billing.overview').datasources.summary.transform;
    const out = (await renderString(t, {
      params: {},
      env: ENV,
      now: NOW,
      ds: {
        bySubscription: {
          thisMonth: [{ key: S1, subscriptionId: S1, name: 'P', cost: 100, currency: 'EUR' }],
          lastMonth: [{ key: S1, subscriptionId: S1, name: 'P', cost: 150, currency: 'EUR' }],
        },
        forecast: null,
      },
      value: {},
    })) as Def;
    expect(out.projectedFrom).toBe('straight-line projection');
    // Cost Management lags about a day: without a forecast the projection runs to yesterday (13.5 of 31 days).
    expect(out.projected).toBeCloseTo(100 * (31 / 13.5), 1);
    expect(out.rows[0]).toMatchObject({ monthToDate: 100, lastMonth: 150 });
  });

  it('invoices: the first billing account you can read, its invoices newest first', async () => {
    const { ds, requests } = await run('billing.invoices');
    expect(ds.account).toMatchObject({
      name: MCA,
      displayName: 'Example Org',
      agreementType: 'MicrosoftCustomerAgreement',
    });
    expect(requests.invoices.path).toBe(
      `/providers/Microsoft.Billing/billingAccounts/${encodeURIComponent(MCA)}/invoices`,
    );
    expect(requests.invoices.query).toEqual({ periodStartDate: '2025-10-01', periodEndDate: '2026-10-15' });
    expect(ds.invoices).toMatchObject({ total: 4, openAmount: 4885.85, overdue: 1, latest: 3685.85 });
    expect(ds.invoices.rows.map((r: Def) => r.invoice)).toEqual([
      'G000000010',
      'G000000009',
      'G000000008',
      'G000000007',
    ]);
  });

  it('budgets keep reading one subscription (Consumption budgets) and sit in the billing area', () => {
    const b = def('azure.budgets');
    expect(b.area).toBe('billing');
    expect(b.datasources.budgets.request.path).toContain('/providers/Microsoft.Consumption/budgets');
  });
});

describe('Azure Billing: finance schedules', () => {
  const schedules = loaded.definitions
    .map((d) => d.def as Def)
    .filter(
      (d) =>
        d.kind === 'schedule' &&
        d.job?.kind === 'report' &&
        REPORTS.includes(d.job.ref) &&
        d.job.ref !== 'azure.budgets',
    );

  it('the weekly cost, the month close and the chargeback mail the finance team', () => {
    expect(schedules.map((s) => s.id).sort()).toEqual([
      'billing.chargeback-monthly',
      'billing.month-close',
      'reports.azure-monthly-cost-weekly',
    ]);
    for (const s of schedules) {
      // Off until the automation identity holds Cost Management Reader and AF_FINANCE_RECIPIENTS is set.
      expect([s.id, s.identity, s.timezone, s.overlap, s.enabled, s.status ?? 'active']).toEqual([
        s.id,
        'automation',
        'UTC',
        'skip',
        false,
        'active',
      ]);
      expect(s.job.delivery[0]).toMatchObject({ type: 'file', format: 'xlsx' });
      expect(s.job.delivery[1]).toMatchObject({
        type: 'email',
        to: ['${ env.AF_FINANCE_RECIPIENTS }'],
        format: 'xlsx',
      });
      expect(s.requires.azureRoles).toEqual(['Cost Management Reader']);
      const when = s.every ? parseSchedule(s.every) : { ok: true, cron: s.cron };
      expect([s.id, when.ok]).toEqual([s.id, true]);
    }
  });

  it('month close runs after Cost Management has settled the month', () => {
    expect(parseSchedule(def('billing.month-close').every)).toMatchObject({ ok: true, cron: '0 7 4 * *' });
  });

  it.each(['billing.month-close', 'billing.chargeback-monthly', 'reports.azure-monthly-cost-weekly'])(
    '%s pins params its report declares, and they render a management-group query',
    async (id) => {
      const s = def(id);
      const { requests } = await run(s.job.ref, s.job.params);
      const last = Object.values<Def>(requests).at(-1);
      expect(last.path).toBe(MG_QUERY);
    },
  );
});
