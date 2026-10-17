import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Rows that already join another Resource Graph table can't also join resourcecontainers (one cross-table join per
// query), so VMs without backup and App Service security read subscription names in a small lookup and join them
// natively ($attach). This runs that lookup on 2,000 subscriptions and the join on each report's largest answer
// (its maxItems) under the real 250 ms budget, and checks rows get the right name. `scale` project: wall-clock budget.

const NOW = '2026-10-17T12:00:00Z';
const USER = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => loaded.definitions.find((d) => d.def.id === id)!.def;
const SCALE_TIMEOUT_MS = 300;
const atScale = async (str: string, scope: Record<string, unknown>) => {
  const full = { now: NOW, user: USER, env: {}, params: {}, ...scope };
  await renderString(str, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(str, full, { timeoutMs: SCALE_TIMEOUT_MS }) as Promise<Def>;
};
const sub = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const SUBSCRIPTIONS = 2_000;

describe.each([
  ['azure.vms-without-backup', 'vms'],
  ['azure.app-service-security', 'apps'],
])('%s subscription names at scale', (id, ds) => {
  it('builds the lookup and names every row within the budget', async () => {
    const d = def(id).datasources;
    const subs = await atScale(d.subs.transform, {
      value: {
        value: Array.from({ length: SUBSCRIPTIONS }, (_, i) => ({
          subscriptionId: sub(i),
          subscriptionName: `Sub ${i}`,
        })),
      },
    });
    expect(subs[sub(7)]).toEqual({ subscriptionName: 'Sub 7' });
    const max = d[ds].maxItems as number;
    const rows = Array.from({ length: max }, (_, i) => ({
      id: `/subscriptions/${sub(i % (SUBSCRIPTIONS + 1))}/x/${i}`,
      name: `item-${i}`,
      subscriptionId: sub(i % (SUBSCRIPTIONS + 1)),
    }));
    const out = await atScale(d[ds].transform, { value: { value: rows, totalRecords: max }, ds: { subs } });
    expect(out.totalRecords).toBe(max);
    expect(out.value).toHaveLength(max);
    expect(out.value[3]).toMatchObject({ name: 'item-3', subscriptionName: 'Sub 3' });
    // A subscription the lookup doesn't know (moved, or no access to it) keeps its id and no name.
    expect(out.value[SUBSCRIPTIONS]).toMatchObject({
      subscriptionId: sub(SUBSCRIPTIONS),
      subscriptionName: null,
    });
  });

  it('keeps an empty answer and one subscription as they are', async () => {
    const d = def(id).datasources;
    expect(await atScale(d.subs.transform, { value: { value: [] } })).toEqual({});
    const one = await atScale(d.subs.transform, {
      value: { value: [{ subscriptionId: sub(1), subscriptionName: 'Only' }] },
    });
    expect(one).toEqual({ [sub(1)]: { subscriptionName: 'Only' } });
    expect(await atScale(d[ds].transform, { value: { value: [] }, ds: { subs: {} } })).toEqual({ value: [] });
  });
});
