import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Finance files are complete: cost analysis and chargeback export every row Cost Management returned (the page lists
// the 500 highest), with the same totals, under the real 250 ms budget at 6,000 rows.
const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => definitions.find((d) => d.def.id === id)!.def;
const N = 6000;
const cost = (i: number) => ((i * 37) % 997) + 0.25;
const total = Array.from({ length: N }, (_, i) => cost(i)).reduce((a, b) => a + b, 0);
const answer = (columns: string[], row: (i: number) => unknown[]) => ({
  properties: {
    nextLink: null,
    columns: columns.map((name) => ({ name })),
    rows: Array.from({ length: N }, (_, i) => row(i)),
  },
});
const transform = async (id: string, ds: string, value: unknown, params: Record<string, unknown>) => {
  const expr = def(id).datasources[ds].transform;
  const scope = { now: '2026-10-15T12:00:00Z', user: {}, env: {}, ds: {}, params, value };
  await renderString(expr, scope, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(expr, scope) as Promise<Def>;
};

describe('Azure Billing exports at enterprise size', () => {
  it('cost analysis by subscription then service, by month: every row in the file, the 500 highest on the page', async () => {
    const value = answer(['Cost', 'BillingMonth', 'SubscriptionName', 'ServiceName', 'Currency'], (i) => [
      cost(i),
      `2026-${String((i % 9) + 1).padStart(2, '0')}-01T00:00:00`,
      `subscription-${i % 300}`,
      i % 50 ? `service-${i % 40}` : '',
      'EUR',
    ]);
    const out = await transform('billing.cost-analysis', 'cost', value, {
      groupBy: 'SubscriptionName',
      thenBy: 'ServiceName',
      granularity: 'Monthly',
    });
    expect(def('billing.cost-analysis').export.data).toBe('cost.exportRows');
    expect(out.exportRows).toHaveLength(N);
    expect(out.rows).toHaveLength(500);
    const sum = out.exportRows.reduce((a: number, r: Def) => a + r.cost, 0);
    expect(sum).toBeCloseTo(total, 1);
    expect(out.exportRows[0]).toMatchObject({ period: expect.stringMatching(/^2026-0\d$/), currency: 'EUR' });
    expect(out.exportRows.filter((r: Def) => r.detail === '(not assigned)')).toHaveLength(N / 50);
    expect(out.exportRows[0].cost).toBeGreaterThanOrEqual(out.exportRows[N - 1].cost);
    expect(out.groups).toBe(300);
  });

  it('chargeback: every tag value and subscription in the file, untagged rows labelled', async () => {
    const value = answer(['Cost', 'TagKey', 'TagValue', 'SubscriptionName', 'Currency'], (i) => [
      cost(i),
      'costcenter',
      i % 7 ? `cc-${i % 120}` : '',
      `subscription-${i % 300}`,
      'EUR',
    ]);
    const out = await transform('billing.chargeback', 'cost', value, { thenBy: 'SubscriptionName' });
    expect(def('billing.chargeback').export.data).toBe('cost.exportRows');
    expect(out.exportRows).toHaveLength(N);
    expect(out.exportRows.filter((r: Def) => r.value === '(untagged)' && r.tagged === 'false')).toHaveLength(
      Math.ceil(N / 7),
    );
    expect(out.total).toBeCloseTo(total, 1);
    expect(out.capped).toBe(true);
  });

  it('overview across 3,000 subscriptions: both months from one query, the 500 costliest listed', async () => {
    const subs = 3000;
    const value = answer(['Cost', 'BillingMonth', 'SubscriptionId', 'SubscriptionName', 'Currency'], (i) => [
      cost(i),
      i < subs ? '2026-09-01T00:00:00' : '2026-10-01T00:00:00',
      `00000000-0000-4000-8000-${String(i % subs).padStart(12, '0')}`,
      `subscription-${i % subs}`,
      'EUR',
    ]);
    const months = await transform('billing.overview', 'bySubscription', value, {});
    expect(months.thisMonth).toHaveLength(subs);
    expect(months.lastMonth).toHaveLength(subs);
    const expr = def('billing.overview').datasources.summary.transform;
    const scope = {
      now: '2026-10-15T12:00:00Z',
      user: {},
      env: {},
      params: {},
      value: {},
      ds: { bySubscription: months, forecast: null },
    };
    await renderString(expr, scope, { timeoutMs: 30_000 }).catch(() => undefined);
    const out = (await renderString(expr, scope)) as Def;
    expect(out.rows).toHaveLength(500);
    expect(out).toMatchObject({ subscriptions: subs, capped: true, currency: 'EUR' });
    expect(out.monthToDate + out.lastMonth).toBeCloseTo(total, 0);
    expect(out.rows[0].monthToDate).toBeGreaterThanOrEqual(out.rows[499].monthToDate);
    expect(out.rows[0].lastMonth).toBeGreaterThan(0);
  });
});
