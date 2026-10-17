import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Content rewritten for large tenants (plan 2026-10-17 Phase A1): filters and counts happen at the source, transforms
// only filter and count what Graph already narrowed, and they stay inside the 250 ms transform budget at enterprise
// sizes. Each test runs the definition's own transform on synthetic rows at the size it must handle, with the real
// budget (the CI machine is shared, so sizes keep a margin).

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const NOW = '2026-10-17T12:00:00Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 864e5).toISOString();

/** A datasource's transform on hand-made data (`ds` for static datasources that read others). */
const transform = (
  id: string,
  ds: string,
  scope: { value?: unknown; ds?: Record<string, unknown>; params?: Record<string, unknown> },
  timeoutMs?: number,
) =>
  renderString(
    def(id).datasources[ds].transform,
    { now: NOW, user: {}, env: {}, params: {}, ...scope },
    timeoutMs ? { timeoutMs } : undefined,
  ) as Promise<Def>;

/** The rendered request query of a datasource. */
const query = async (id: string, ds: string, params: Record<string, unknown> = {}) => {
  const q = def(id).datasources[ds].request.query as Record<string, string>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q))
    out[k] = typeof v === 'string' && v.includes('${') ? await renderString(v, { now: NOW, params }) : v;
  return out;
};

const member = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  displayName: `User ${i}`,
  userPrincipalName: `user${i}@example.com`,
  accountEnabled: i % 7 !== 0,
  userType: 'Member',
  department: `Dept ${i % 30}`,
  createdDateTime: daysAgo(400),
  onPremisesSyncEnabled: i % 5 === 0 ? true : null,
  assignedLicenses: i % 3 ? [{ skuId: 'sku' }] : [],
  ...extra,
});

describe('identity.inactive-users at scale', () => {
  it('asks Graph for inactive accounts and for members older than the window — nothing reads every member', async () => {
    const inactive = await query('identity.inactive-users', 'inactive', { days: 90 });
    expect(inactive.$filter).toMatch(/^signInActivity\/lastSuccessfulSignInDateTime le \d{4}-\d\d-\d\dT/);
    const never = await query('identity.inactive-users', 'never', { days: 180 });
    expect(never.$filter).toMatch(
      /^userType eq 'Member' and createdDateTime le \d{4}-.* and accountEnabled eq true$/,
    );
    const withBlocked = await query('identity.inactive-users', 'never', { days: 180, includeDisabled: true });
    expect(withBlocked.$filter).not.toMatch(/accountEnabled/);
    expect(def('identity.inactive-users').datasources.never.maxItems).toBeLessThanOrEqual(5_000);
  });

  it('keeps members only, blocked and unlicensed accounts by choice; accounts with no successful sign-in first', async () => {
    const inactive = [
      member(1, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(120) } }),
      member(2, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(300) } }),
      member(7, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(200) } }), // blocked
      { ...member(8, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(200) } }), userType: 'Guest' },
    ];
    const never = [member(10), member(11, { signInActivity: { lastSignInDateTime: daysAgo(500) } })];
    const out = await transform('identity.inactive-users', 'users', {
      ds: { inactive: { value: inactive }, never: { value: never } },
    });
    // User 11 only has failed or pre-2023 sign-ins: no successful sign-in recorded, so it is listed with User 10.
    expect(out.rows.map((r: Def) => [r.displayName, r.state])).toEqual([
      ['User 10', 'never'],
      ['User 11', 'never'],
      ['User 2', 'inactive'],
      ['User 1', 'inactive'],
    ]);
    expect(out).toMatchObject({ total: 4, never: 2, partial: false });
    const all = await transform('identity.inactive-users', 'users', {
      ds: { inactive: { value: inactive }, never: { value: never } },
      params: { includeDisabled: true, licensedOnly: true },
    });
    // User 7 (blocked) now counts; licensed only keeps User 1, 2, 7, 10 and 11.
    expect(all.rows.map((r: Def) => r.displayName).sort()).toEqual([
      'User 1',
      'User 10',
      'User 11',
      'User 2',
      'User 7',
    ]);
  });

  it('re-checks the window itself and says when a read stopped at its cap', async () => {
    const recent = member(3, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(5) } });
    const signedIn = member(12, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(400) } });
    const out = await transform('identity.inactive-users', 'users', {
      ds: { inactive: { value: [recent], truncated: true }, never: { value: [signedIn] } },
    });
    expect(out.rows).toEqual([]); // recent: still active; signedIn: has a successful sign-in, so not "none recorded"
    expect(out.partial).toBe(true);
  });

  it('20k inactive and 3k never-signed-in accounts within the budget', async () => {
    const inactive = Array.from({ length: 20_000 }, (_, i) =>
      member(i, { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(91 + (i % 300)) } }),
    );
    const never = Array.from({ length: 3_000 }, (_, i) => member(100_000 + i));
    const out = await transform('identity.inactive-users', 'users', {
      ds: { inactive: { value: inactive }, never: { value: never } },
    });
    expect(out.total).toBeGreaterThan(19_000); // every 7th account is blocked (left out by default)
  });
});

// Owners (2026-10-17, live): GET /groups/{id}/owners without a cast leaves service principals out while owners/$count
// counts them, and an app can own a group but can't be accountable for it — so "no owner at all", "owned by an app
// only" and "one person" are told apart everywhere, and the tables agree with the counts.
const sp = (id: string) => ({
  '@odata.type': '#microsoft.graph.servicePrincipal',
  id,
  displayName: `App ${id}`,
});
const person = (id: string) => ({
  '@odata.type': '#microsoft.graph.user',
  id,
  displayName: `Person ${id}`,
  userPrincipalName: `${id}@example.com`,
});
const group = (id: string, owners?: unknown[], extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  displayName: `Group ${id}`,
  groupTypes: ['Unified'],
  ...(owners ? { owners } : {}),
  ...extra,
});

describe('owners: people and apps', () => {
  it('identity.group reads people and apps apart, and its total matches owners/$count', async () => {
    const out = await transform('identity.group', 'owners', {
      value: { people: { value: [person('p1')] }, apps: { value: [sp('a1')] } },
    });
    expect(out).toMatchObject({ total: 2 });
    expect(out.people).toHaveLength(1);
    expect(out.apps).toHaveLength(1);
  });

  it('identity.groups-without-owners lists groups owned only by apps apart from groups with no owner at all', async () => {
    const owned = [group('1', [person('p1'), sp('a1')]), group('2', [sp('a2')]), group('3', [person('p3')])];
    const ownerless = [group('4')];
    const out = await transform('identity.groups-without-owners', 'report', {
      value: { ownerless, owned, membership: [] },
      params: { issue: 'noOwners' },
    });
    expect(out.rows.map((r: Def) => [r.displayName, r.issue])).toEqual([
      ['Group 4', 'No owners'],
      ['Group 2', 'Owned by an app only'],
    ]);
    expect(out).toMatchObject({ noOwners: 1, appOnly: 1, m365NoOwners: 2 });
  });

  it('m365.teams-without-owners: no owner, app only, one person (Graph count minus app-only), archived left out on request', async () => {
    const teams = [group('1', []), group('2', [sp('a2')]), group('3', [person('p3')]), group('5', [])];
    const oneOwner = [group('2'), group('3')];
    const out = await transform('m365.teams-without-owners', 'report', {
      value: { teams, oneOwner, archived: { known: true, ids: [group('5').id] } },
      params: { includeSingleOwner: true, includeArchived: false },
    });
    expect(out.rows.map((r: Def) => [r.displayName, r.ownership, r.archived])).toEqual([
      ['Group 1', 'none', false],
      ['Group 2', 'appOnly', false],
      ['Group 3', 'single', false],
    ]);
    expect(out).toMatchObject({ ownerless: 1, appOnly: 1, singleOwner: 1, total: 4 });
  });

  it('m365.teams labels each team of the page by its owners: none, app only, one person, two or more', async () => {
    const out = await transform('m365.teams', 'teams', {
      value: {
        value: [
          group('1', []),
          group('2', [sp('a2')]),
          group('3', [person('p3')]),
          group('4', [person('p4'), person('p5'), sp('a6')]),
        ],
      },
      params: { ownership: 'All' },
    });
    expect(out.value.map((t: Def) => [t.ownership, t.ownerCount, t.appOwners])).toEqual([
      ['none', 0, 0],
      ['appOnly', 0, 1],
      ['single', 1, 0],
      ['healthy', 2, 1],
    ]);
  });
});

describe('Microsoft 365 usage reports at scale', () => {
  it('m365.mailbox-storage: 20k mailboxes within the budget, over/near quota first, counts over every mailbox', async () => {
    const value = Array.from({ length: 20_000 }, (_, i) => ({
      userPrincipalName: `u${i}@example.com`,
      displayName: `User ${i}`,
      isDeleted: false,
      storageUsedInBytes: (i % 110) * 5e8,
      prohibitSendQuotaInBytes: 5e10,
      lastActivityDate: daysAgo(i % 200).slice(0, 10),
      createdDate: '2020-01-01',
    }));
    const out = await transform('m365.mailbox-storage', 'mailboxList', {
      value: { value },
      params: { view: 'attention', threshold: 90, inactiveDays: 90 },
    });
    expect(out.rows[0].state).toBe('full');
    expect(out.mailboxes).toBe(20_000);
    expect(out.full).toBe(value.filter((m) => m.storageUsedInBytes >= m.prohibitSendQuotaInBytes).length);
    // The list datasource keeps every mailbox of the view (the export reads it); the page's view shows 10,000.
    expect(out.partial).toBe(false);
    const page = await transform('m365.mailbox-storage', 'mailboxes', { value: out });
    expect(page.rows).toHaveLength(Math.min(out.rows.length, 10_000));
    expect(page.listCapped).toBe(out.rows.length > 10_000);
    expect(page).toMatchObject({ mailboxes: 20_000, full: out.full });
    expect(def('m365.mailbox-storage').export).toMatchObject({ data: 'mailboxList.rows', maxRows: 40_000 });
  });
});
