import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Hybrid Azure Arc at 20,000 servers. The lists (servers, extensions, patching, Defender coverage, the two Arc
// reports and the server page's updates, installations and recommendations) send their rows as Resource Graph returns
// them — no transform, so the 250 ms budget never depends on the fleet's size. Every transform the Arc content does
// have reads a Resource Graph summary (one row), a top-N or one row per Azure region; each one runs here on the
// largest answer its query can produce for that fleet, under the real budget. Run in the `scale` project (after the
// other projects, one file at a time) because the budget is wall-clock. Behaviour: arc-fleet.test.ts.

const NOW = '2026-10-17T12:00:00Z';
const USER = {
  oid: '00000000-0000-4000-8000-000000000001',
  upn: 'tester@example.com',
  roles: ['Portal.Reader'],
};
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

const SERVERS = 20_000;
const REGIONS = 60;
// A large enterprise's subscriptions (Defender for Servers plans are read once per subscription).
const SUBSCRIPTIONS = 1_000;
// The API's 250 ms budget plus 20 % for a test runner that shares the CPU with the other test files.
const SCALE_TIMEOUT_MS = 300;
const atScale = async (str: string, scope: Record<string, unknown>) => {
  const full = { now: NOW, user: USER, env: {}, params: {}, ...scope };
  // One untimed run first (compiling the expression and warming the JIT, as the API does once per definition).
  await renderString(str, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(str, full, { timeoutMs: SCALE_TIMEOUT_MS }) as Promise<Def>;
};

const ARC = [
  'azure.arc-fleet',
  'azure.arc-servers',
  'azure.arc-extensions',
  'azure.arc-patching',
  'azure.arc-defender-coverage',
  'azure.arc-server',
  'azure.arc-disconnected',
  'azure.arc-agent-health',
];
/** Datasources that return one row per server, extension, update, run or recommendation. */
const ROW_LISTS: Array<[string, string]> = [
  ['azure.arc-servers', 'machines'],
  ['azure.arc-extensions', 'extensions'],
  ['azure.arc-patching', 'machines'],
  ['azure.arc-patching', 'unassessed'],
  ['azure.arc-defender-coverage', 'machines'],
  ['azure.arc-disconnected', 'machines'],
  ['azure.arc-agent-health', 'machines'],
  ['azure.arc-server', 'extensions'],
  ['azure.arc-server', 'updates'],
  ['azure.arc-server', 'installs'],
  ['azure.arc-server', 'recommendations'],
];

/** The most rows the query can return for the fleet: a summary row, its `top N`, or one per region. */
function largestAnswer(q: string): number {
  // The outer pipeline only: quoted text, then join subqueries and calls, innermost first.
  let body = q.replace(/'[^']*'/g, "''");
  while (/\([^()]*\)/.test(body)) body = body.replace(/\([^()]*\)/g, '');
  const top = /\|\s*top\s+(\d+)\s+by/.exec(body);
  if (top) return Number(top[1]);
  if (/\|\s*take\s+1\b/.test(body)) return 1;
  const summarize = [...body.matchAll(/\|\s*summarize\b([^|]*)/g)].at(-1)?.[1] ?? '';
  if (summarize && !/\bby\b/.test(summarize)) return 1;
  if (/\bby\s+location\b/.test(summarize)) return REGIONS;
  if (/\bby\s+subscriptionId\s*$/.test(summarize)) return SUBSCRIPTIONS;
  if (/\bby\s+bucket\b/.test(summarize)) return 6;
  return SERVERS;
}

const subscription = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const machine = (i: number) => ({
  id: `/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-${i % 300}/providers/Microsoft.HybridCompute/machines/srv-${i}`,
  name: `srv-${i}`,
  location: `region-${i % REGIONS}`,
  subscriptionId: subscription(i % SUBSCRIPTIONS),
  tier: i % 3 === 0 ? 'Free' : 'Standard',
  subPlan: i % 2 === 0 ? 'P2' : 'P1',
  machines: SERVERS - i,
  total: SERVERS,
  connected: SERVERS - 900,
  notConnected: 900,
  expired: 120,
  status: i % 9 === 0 ? 'Disconnected' : 'Connected',
  properties: {
    status: 'Connected',
    agentVersion: '1.48.02881.1941',
    errorDetails: Array.from({ length: 5 }, (_, k) => ({ code: `AZCM00${k}`, message: 'Network error' })),
    agentUpgrade: { enableAutomaticUpgrade: true },
    licenseProfile: { esuProfile: { esuEligibility: 'Eligible', licenseAssignmentState: 'Assigned' } },
  },
});

describe('Azure Arc at 20,000 servers', () => {
  it.each(ROW_LISTS)('%s#%s sends its rows without a transform', (id, ds) => {
    expect(def(id).datasources[ds].source).toBe('resourceGraph');
    expect(def(id).datasources[ds].transform).toBeUndefined();
    expect(largestAnswer(def(id).datasources[ds].query)).toBe(SERVERS);
  });

  const transforms = ARC.flatMap((id) =>
    Object.entries<Def>(def(id).datasources)
      .filter(([, d]) => d.transform)
      .map(([name, d]) => [`${id}#${name}`, id, name, d] as const),
  );

  it('covers every Arc transform', () => {
    expect(transforms.length).toBeGreaterThanOrEqual(15);
  });

  it.each(transforms)('%s runs on its largest answer within the budget', async (_, id, name, d) => {
    const rows = d.source === 'resourceGraph' ? largestAnswer(d.query) : 1;
    expect([id, name, rows < SERVERS]).toEqual([id, name, true]);
    const value = { value: Array.from({ length: rows }, (_, i) => machine(i)), totalRecords: rows };
    const counts = { connected: SERVERS - 900, notConnected: 900, expired: 120 };
    const started = performance.now();
    const out = await atScale(d.transform, {
      value,
      ds: { counts },
      params: { id: machine(0).id },
    });
    expect(out).toBeDefined();
    expect(performance.now() - started).toBeLessThan(SCALE_TIMEOUT_MS);
  });

  it('the fleet dashboard keeps its region donut to six slices, folded in Resource Graph', () => {
    const d = def('azure.arc-fleet').datasources.byRegion;
    expect(d.query).toContain('| top 5 by n desc');
    expect(d.query).toContain("| extend location = iff(keep == 1, location, 'Other')");
    expect(d.transform).toBe('${ [value.value] }');
  });

  it('Defender coverage passes 1,000 subscriptions’ plans into its queries within the budget', async () => {
    const plans = def('azure.arc-defender-coverage').datasources.plans;
    const value = { value: Array.from({ length: SUBSCRIPTIONS }, (_, i) => machine(i)) };
    const lists = await atScale(plans.transform, { value });
    // Each subscription is in exactly one list (P2, P1, other On, Off), so the queries grow by one id per subscription.
    expect(lists.p2.length + lists.p1.length + lists.on.length + lists.off.length).toBe(SUBSCRIPTIONS);
    for (const ds of ['machines', 'summary']) {
      const started = performance.now();
      const q = (await atScale(def('azure.arc-defender-coverage').datasources[ds].query, {
        ds: { plans: lists },
        params: { coverage: 'Gaps', osType: 'All' },
      })) as string;
      expect(performance.now() - started).toBeLessThan(SCALE_TIMEOUT_MS);
      expect(q).toContain(`'${subscription(SUBSCRIPTIONS - 2)}'`);
      expect(q.length).toBeLessThan(60_000);
    }
  });
});
