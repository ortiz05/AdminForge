import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The Groups page's member views at fleet size: 50,000 groups (the member read's maxItems), each with 0–20 expanded
// members (Graph's expansion cap), in every kind, membership and source. Each transform runs under the real 250 ms
// budget (plus 20 % for a shared CPU), after one untimed warm-up. `scale` project, one file at a time. Behaviour:
// groups-views.test.ts.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const PAGE: Def = loaded.definitions.find((d) => d.def.id === 'identity.groups')!.def;
const DEFAULTS = Object.fromEntries(
  Object.entries(PAGE.params as Record<string, Def>).map(([k, p]) => [k, p.default ?? '']),
);
const SCALE_TIMEOUT_MS = 300;
const atScale = async (str: string, scope: Record<string, unknown>) => {
  const full = { now: '2026-10-22T12:00:00Z', user: {}, env: {}, ds: {}, ...scope };
  await renderString(str, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(str, full, { timeoutMs: SCALE_TIMEOUT_MS }) as Promise<Def>;
};

const GROUPS = 50_000;
const TYPES = [[], ['Unified'], ['DynamicMembership'], ['Unified', 'DynamicMembership']];
const everyGroup = {
  value: Array.from({ length: GROUPS }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    displayName: `Group ${i}`,
    description: i % 3 ? `Team ${i % 97}` : null,
    mail: i % 2 ? `group${i}@example.com` : null,
    mailEnabled: i % 2 === 1,
    securityEnabled: i % 5 !== 0,
    groupTypes: TYPES[i % 4],
    membershipRuleProcessingState: i % 4 >= 2 ? (i % 8 === 2 ? 'Paused' : 'On') : null,
    onPremisesSyncEnabled: i % 6 === 0 ? true : null,
    isAssignableToRole: i % 50 === 0,
    createdDateTime: `20${20 + (i % 7)}-0${1 + (i % 9)}-15T09:00:00Z`,
    renewedDateTime: `20${20 + (i % 7)}-0${1 + (i % 9)}-15T09:00:00Z`,
    expirationDateTime: i % 4 === 1 ? '2026-11-05T09:00:00Z' : null,
    members: Array.from({ length: i % 21 }, (_, j) => ({ id: `m${j}` })),
  })),
};
const ownerIds = { value: everyGroup.value.filter((_, i) => i % 3 === 0).map((g) => ({ id: g.id })) };

async function matches(params: Record<string, unknown>): Promise<Def> {
  const p = { ...DEFAULTS, ...params };
  const ds = PAGE.datasources.memberMatches;
  const value = await renderString(ds.data, {
    now: '2026-10-22T12:00:00Z',
    params: p,
    ds: { everyGroup, ownerIds },
  });
  return atScale(ds.transform, { params: p, value });
}

describe('identity.groups member views at 50,000 groups', () => {
  it('fewer than 5 members: filtered, counted and labelled within the budget', async () => {
    const out = await matches({ members: 'UnderFive' });
    expect(out.rows.length).toBe(everyGroup.value.filter((g) => g.members.length < 5).length);
    expect(out.rows[0]).toHaveProperty('kind');
    expect(out.rows[0]).toHaveProperty('sourceLabel');
  });

  it('no members, with every facet, the owner ids and a search, within the budget', async () => {
    const out = await matches({
      members: 'None',
      kind: 'Security',
      membership: 'Assigned',
      source: 'Cloud',
      roleAssignable: 'No',
      created: 'OverAYear',
      owners: 'None',
      q: 'group',
    });
    expect(Array.isArray(out.rows)).toBe(true);
  });

  it('the browser view caps 10,000 of the matches within the budget', async () => {
    const all = await matches({ members: 'UnderFive' });
    const list = await atScale(PAGE.datasources.groupList.transform, {
      params: { ...DEFAULTS, members: 'UnderFive' },
      value: all,
    });
    expect(list.rows).toHaveLength(Math.min(10_000, all.rows.length));
    expect(list.matched).toBe(all.rows.length);
  });
});
