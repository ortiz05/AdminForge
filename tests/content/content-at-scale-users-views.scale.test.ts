import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The Users page's inactivity views at fleet size: 50,000 accounts from Graph's sign-in filter (the read's maxItems),
// members and guests, licensed or not, cloud and synced. Each transform runs under the real 250 ms budget (plus 20 %
// for a shared CPU), after one untimed warm-up. `scale` project, one file at a time. Behaviour: users-views.test.ts.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const PAGE: Def = loaded.definitions.find((d) => d.def.id === 'identity.users')!.def;
const DEFAULTS = Object.fromEntries(
  Object.entries(PAGE.params as Record<string, Def>).map(([k, p]) => [k, p.default ?? '']),
);
const SCALE_TIMEOUT_MS = 300;
const atScale = async (str: string, scope: Record<string, unknown>) => {
  const full = { now: '2026-10-22T12:00:00Z', user: {}, env: {}, ds: {}, ...scope };
  await renderString(str, full, { timeoutMs: 30_000 }).catch(() => undefined);
  return renderString(str, full, { timeoutMs: SCALE_TIMEOUT_MS }) as Promise<Def>;
};

const USERS = 50_000;
const DEPARTMENTS = ['Finance', 'Sales', 'Engineering', 'Operations', 'Legal', null];
const inactive = {
  value: Array.from({ length: USERS }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    displayName: `Person ${i}`,
    userPrincipalName: `person${i}@example.com`,
    mail: `person${i}@example.com`,
    accountEnabled: i % 9 !== 0,
    userType: i % 7 === 0 ? 'Guest' : 'Member',
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    jobTitle: 'Analyst',
    createdDateTime: `20${19 + (i % 8)}-0${1 + (i % 9)}-10T09:00:00Z`,
    onPremisesSyncEnabled: i % 4 === 0 ? true : null,
    onPremisesLastSyncDateTime: i % 4 === 0 ? '2026-10-22T08:00:00Z' : null,
    assignedLicenses: i % 3 ? [{ skuId: 'sku-e3' }] : [],
    externalUserState: i % 7 === 0 ? (i % 2 ? 'PendingAcceptance' : 'Accepted') : null,
    signInActivity: { lastSuccessfulSignInDateTime: '2025-06-01T09:00:00Z' },
  })),
};

async function matches(params: Record<string, unknown>): Promise<Def> {
  const p = { ...DEFAULTS, activity: 'Inactive90', ...params };
  const ds = PAGE.datasources.inactiveMatches;
  const value = await renderString(ds.data, { now: '2026-10-22T12:00:00Z', params: p, ds: { inactive } });
  return atScale(ds.transform, { params: p, value });
}

describe('identity.users inactivity views at 50,000 accounts', () => {
  it('every account, labelled, within the budget', async () => {
    const out = await matches({});
    expect(out.rows).toHaveLength(USERS);
    expect(out.rows[0]).toHaveProperty('licenceState');
  });

  it('every facet and a search, within the budget', async () => {
    const out = await matches({
      userType: 'Member',
      enabled: 'Enabled',
      licensed: 'Licensed',
      source: 'Cloud',
      department: 'sal',
      created: 'Any',
      q: 'person1',
    });
    expect(out.rows.length).toBeGreaterThan(0);
  });

  it('the browser view caps 10,000 within the budget', async () => {
    const all = await matches({});
    const list = await atScale(PAGE.datasources.userList.transform, {
      params: { ...DEFAULTS, activity: 'Inactive90' },
      value: all,
    });
    expect(list).toMatchObject({ matched: USERS, listCapped: true });
    expect(list.rows).toHaveLength(10_000);
  });
});
