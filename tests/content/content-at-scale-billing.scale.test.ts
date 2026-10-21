import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Azure Billing at enterprise size: Cost Management answers with arrays of rows (one per group, day or month), up to a
// few thousand per page across hundreds of subscriptions. Each transform sorts the raw rows natively, adds every row
// into its totals and turns only the highest few hundred into table rows. Each test runs the definition's own
// transform on 6,000 synthetic rows with the real 250 ms budget.

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const NOW = '2026-10-15T12:00:00Z';
const N = 6000;
// One untimed run first (compiling the expression and warming the JIT, as the API does once per definition), then the
// measured run under the real 250 ms budget.
const transform = async (
  id: string,
  ds: string,
  scope: { value?: unknown; ds?: Record<string, unknown>; params?: Record<string, unknown> },
) => {
  const expr = def(id).datasources[ds].transform;
  const full = { now: NOW, user: {}, env: {}, params: {}, ...scope };
  await renderString(expr, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(expr, full) as Promise<Def>;
};
const answer = (columns: string[], row: (i: number) => unknown[], nextLink: string | null = null) => ({
  properties: {
    nextLink,
    columns: columns.map((name) => ({ name, type: 'String' })),
    rows: Array.from({ length: N }, (_, i) => row(i)),
  },
});
const cost = (i: number) => ((i * 37) % 997) + 0.25;
const total = Array.from({ length: N }, (_, i) => cost(i)).reduce((a, b) => a + b, 0);

describe('Azure Billing transforms at enterprise size', () => {
  it('cost analysis by resource: the 500 highest of 6,000, the total over all of them', async () => {
    const value = answer(['Cost', 'ResourceId', 'Currency'], (i) => [
      cost(i),
      `/subscriptions/s/resourcegroups/rg/providers/p/t/r${i}`,
      'EUR',
    ]);
    const out = await transform('billing.cost-analysis', 'cost', {
      value,
      params: { groupBy: 'ResourceId', thenBy: 'None', granularity: 'None' },
    });
    expect(out.rows).toHaveLength(500);
    expect(out.rows[0].cost).toBeGreaterThanOrEqual(out.rows[499].cost);
    expect(out.total).toBeCloseTo(total, 1);
    expect(out).toMatchObject({ capped: true, partial: false, groups: N, currency: 'EUR' });
  });

  it('cost analysis by day: the five highest services over time', async () => {
    const value = answer(
      ['Cost', 'UsageDate', 'ServiceName', 'Currency'],
      (i) => [cost(i), 20261001 + (i % 30), `service-${i % 200}`, 'EUR'],
      'https://management.azure.com/next',
    );
    const out = await transform('billing.cost-analysis', 'cost', {
      value,
      params: { groupBy: 'ServiceName', thenBy: 'None', granularity: 'Daily' },
    });
    expect(out.byPeriod).toBe(true);
    expect(new Set(out.trend.map((r: Def) => r.group)).size).toBeLessThanOrEqual(5);
    expect(out.partial).toBe(true);
  });

  it('cost analysis by subscription then service', async () => {
    const value = answer(['Cost', 'SubscriptionName', 'ServiceName', 'Currency'], (i) => [
      cost(i),
      `subscription-${i % 300}`,
      `service-${i}`,
      'EUR',
    ]);
    const out = await transform('billing.cost-analysis', 'cost', {
      value,
      params: { groupBy: 'SubscriptionName', thenBy: 'ServiceName', granularity: 'None' },
    });
    expect(out.rows).toHaveLength(500);
    expect(out.top).toHaveLength(10);
  });

  it('top resources ranks 6,000 resources', async () => {
    const value = answer(['Cost', 'ResourceId', 'Currency'], (i) => [
      cost(i),
      `/subscriptions/s${i % 9}/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm${i}`,
      'EUR',
    ]);
    const out = await transform('billing.top-resources', 'cost', { value, params: { top: 250 } });
    expect(out.rows).toHaveLength(250);
    expect(out.resources).toBe(N);
    expect(out.rows[0]).toMatchObject({ type: 'microsoft.compute/virtualmachines', resourceGroup: 'rg' });
  });

  it('chargeback by tag and subscription, with the untagged cost over every row', async () => {
    const value = answer(['Cost', 'TagKey', 'TagValue', 'SubscriptionName', 'Currency'], (i) => [
      cost(i),
      i % 7 ? 'CostCenter' : '',
      i % 7 ? `CC-${i % 400}` : '',
      `subscription-${i % 300}`,
      'EUR',
    ]);
    const out = await transform('billing.chargeback', 'cost', {
      value,
      params: { thenBy: 'SubscriptionName', tagKey: 'CostCenter' },
    });
    const untagged = Array.from({ length: N }, (_, i) => (i % 7 ? 0 : cost(i))).reduce((a, b) => a + b, 0);
    expect(out.untagged).toBeCloseTo(untagged, 1);
    expect(out.rows).toHaveLength(500);
  });

  it('monthly trend over twelve months of 500 resource groups', async () => {
    const months = await renderString(def('billing.monthly-trend').datasources.months.transform, {
      params: { months: 12 },
      now: NOW,
      value: {},
    });
    const list = (months as Def).list as string[];
    const value = answer(['Cost', 'BillingMonth', 'ResourceGroupName', 'Currency'], (i) => [
      cost(i),
      `${list[i % 12]}-01T00:00:00`,
      `rg-${Math.floor(i / 12)}`,
      'EUR',
    ]);
    const out = await transform('billing.monthly-trend', 'trend', {
      value,
      params: { groupBy: 'ResourceGroupName', months: 12 },
      ds: { months },
    });
    expect(out.capped).toBe(true);
    expect(out.lines.length).toBeGreaterThan(0);
    expect(out.total).toBeCloseTo(total, 1);
  });

  it('this month and last by resource group across 6,000 groups', async () => {
    const value = answer(['Cost', 'ResourceGroupName', 'Currency'], (i) => [cost(i), `rg-${i}`, 'EUR']);
    const params = { groupBy: 'ResourceGroupName' };
    const monthToDate = await transform('azure.monthly-cost', 'monthToDate', { value, params });
    expect(monthToDate.rows).toHaveLength(500);
    const out = await transform('azure.monthly-cost', 'cost', { value, params, ds: { monthToDate } });
    expect(out.capped).toBe(true);
    expect(out.monthToDate).toBeCloseTo(total, 1);
    expect(out.lastMonth).toBeCloseTo(total, 1);
  });
});
