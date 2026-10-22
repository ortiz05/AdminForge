import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { activeBlocks, neededDatasources } from '@adminforge/web/src/renderer/page-model';
import { repoRoot } from '../lib/repo';

// The Users page's views (docs/plans/2026-10-22-group-and-user-views.md): invitations and new accounts are Graph
// filters on the page's own list; the inactivity views read Graph's sign-in filter alone (it can't be combined with
// any other) and apply the page's facets natively, labelled by partition. Fleet size:
// content-at-scale-users-views.scale.test.ts.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const PAGE: Def = loaded.definitions.find((d) => d.def.id === 'identity.users')!.def;
const NOW = '2026-10-22T12:00:00Z';
const DEFAULTS = Object.fromEntries(
  Object.entries(PAGE.params as Record<string, Def>).map(([k, p]) => [k, p.default ?? '']),
);
const scope = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  now: NOW,
  user: {},
  env: {},
  params: { ...DEFAULTS, ...params },
  ds: {},
  ...extra,
});
const filter = (params: Record<string, unknown>) =>
  renderString(PAGE.datasources.users.request.query.$filter, { ...scope(params), advanced: '' });
const when = (ds: string, params: Record<string, unknown>) =>
  renderString(PAGE.datasources[ds].when, scope(params));
async function view(
  name: string,
  params: Record<string, unknown>,
  ds: Record<string, unknown>,
): Promise<Def> {
  const d = PAGE.datasources[name];
  const value = typeof d.data === 'string' ? await renderString(d.data, scope(params, { ds })) : d.data;
  return renderString(d.transform, scope(params, { value, ds }));
}

let n = 0;
const user = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  displayName: `User ${n}`,
  userPrincipalName: `user${n}@example.com`,
  accountEnabled: true,
  userType: 'Member',
  department: null,
  createdDateTime: '2024-01-15T09:00:00Z',
  onPremisesSyncEnabled: null,
  assignedLicenses: [{ skuId: 'sku-e3' }],
  externalUserState: null,
  signInActivity: { lastSuccessfulSignInDateTime: '2026-01-10T09:00:00Z' },
  ...over,
});
const AVERY = user({ displayName: 'Avery Example', department: 'Finance' });
const BLAKE = user({ displayName: 'Blake Example', accountEnabled: false, assignedLicenses: [] });
const GUEST = user({
  displayName: 'Casey Partner',
  userPrincipalName: 'casey_partner.example#EXT#@example.com',
  userType: 'Guest',
  externalUserState: 'PendingAcceptance',
  assignedLicenses: [],
});
const SYNCED = user({ displayName: 'Drew Synced', onPremisesSyncEnabled: true, department: 'Sales Ops' });
const NEW = user({ displayName: 'Emery New', createdDateTime: '2026-10-01T09:00:00Z' });
const ALL = [AVERY, BLAKE, GUEST, SYNCED, NEW];
const inactiveView = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  view('inactiveMatches', { activity: 'Inactive90', ...params }, { inactive: { value: ALL, ...extra } });
const names = (rows: Def[]) => rows.map((r) => r.displayName).sort();

describe('identity.users — views Graph filters', () => {
  it.each([
    [{ invitation: 'Pending' }, "externalUserState eq 'PendingAcceptance'"],
    [{ created: 'Last30Days' }, 'createdDateTime ge 2026-09-22T12:00:00.000Z'],
    [
      { enabled: 'Disabled', licensed: 'Licensed' },
      'accountEnabled eq false and assignedLicenses/$count ne 0',
    ],
  ])('%o filters on %s', async (params, clause) => {
    expect(await filter(params)).toBe(clause);
  });

  it('ships a preset for every view, naming only declared params and values', () => {
    const presets = PAGE.savedViews.presets as Array<{ name: string; params: Record<string, unknown> }>;
    for (const want of [
      'Pending guest invitations',
      'Blocked but licensed',
      'New in the last 30 days',
      'Members inactive 90 days',
      'No sign-in for a year',
    ])
      expect(presets.map((p) => p.name)).toContain(want);
    for (const p of presets)
      for (const [k, v] of Object.entries(p.params)) {
        const param = PAGE.params[k];
        expect(param, `${p.name}: ${k}`).toBeDefined();
        if (param.type !== 'enum') continue;
        const values = (param.values as Array<string | { value: string }>).map((x) =>
          typeof x === 'string' ? x : x.value,
        );
        expect(values, `${p.name}: ${k}=${String(v)}`).toContain(v);
      }
  });

  it('offers every new view as a facet', () => {
    expect(PAGE.filters.facets).toEqual(expect.arrayContaining(['invitation', 'created', 'activity']));
  });
});

describe('identity.users — inactivity views', () => {
  it('switches the list: the sign-in read and its table on, the Graph list off; the MFA view wins', async () => {
    for (const activity of ['Inactive90', 'Inactive365']) {
      expect(await when('inactive', { activity })).toBe(true);
      expect(await when('userList', { activity })).toBe(true);
      expect(await when('users', { activity })).toBe(false);
      expect(await when('inactive', { activity, mfa: 'NotRegistered' })).toBe(false);
    }
    expect(await when('inactive', {})).toBe(false);
    expect(await when('users', {})).toBe(true);
  });

  it('sends Graph the sign-in filter alone, whatever the facets (Graph refuses it combined)', async () => {
    const f = (params: Record<string, unknown>) =>
      renderString(PAGE.datasources.inactive.request.query.$filter, scope(params));
    expect(await f({ activity: 'Inactive90', userType: 'Member', enabled: 'Enabled', q: 'x' })).toBe(
      'signInActivity/lastSuccessfulSignInDateTime le 2026-07-24T12:00:00.000Z',
    );
    expect(await f({ activity: 'Inactive365' })).toBe(
      'signInActivity/lastSuccessfulSignInDateTime le 2025-10-22T12:00:00.000Z',
    );
    expect(PAGE.datasources.inactive.request.headers?.ConsistencyLevel).toBeUndefined();
    expect(PAGE.datasources.inactive.requires?.licences).toContain('signInLogs');
  });

  it('applies each facet natively', async () => {
    const pick = async (params: Record<string, unknown>) => names((await inactiveView(params)).rows);
    expect(await pick({})).toEqual(names(ALL));
    expect(await pick({ userType: 'Guest' })).toEqual(names([GUEST]));
    expect(await pick({ userType: 'Member', enabled: 'Enabled' })).toEqual(names([AVERY, SYNCED, NEW]));
    expect(await pick({ enabled: 'Disabled' })).toEqual(names([BLAKE]));
    expect(await pick({ licensed: 'Unlicensed' })).toEqual(names([BLAKE, GUEST]));
    expect(await pick({ licensed: 'Licensed' })).toEqual(names([AVERY, SYNCED, NEW]));
    expect(await pick({ source: 'Synced' })).toEqual(names([SYNCED]));
    expect(await pick({ source: 'Cloud' })).not.toContain('Drew Synced');
    expect(await pick({ department: 'finance' })).toEqual(names([AVERY]));
    expect(await pick({ invitation: 'Pending' })).toEqual(names([GUEST]));
    expect(await pick({ created: 'Last30Days' })).toEqual(names([NEW]));
  });

  it('searches the name and the sign-in name, without listing a person twice', async () => {
    const pick = async (q: string) => names((await inactiveView({ q })).rows);
    expect(await pick('avery')).toEqual(names([AVERY]));
    expect(await pick('partner')).toEqual(names([GUEST]));
    expect(await pick('example')).toEqual(names(ALL));
    expect(await pick('x'.repeat(300))).toEqual([]);
  });

  it('labels licences and source as the Graph list does', async () => {
    const rows = (await inactiveView({})).rows;
    const label = (u: Def) => rows.find((r: Def) => r.id === u.id);
    expect(label(AVERY)).toMatchObject({ licenceState: 'Licensed', sourceLabel: 'Cloud' });
    expect(label(BLAKE)).toMatchObject({ licenceState: 'Unlicensed' });
    expect(label(SYNCED)).toMatchObject({ sourceLabel: 'Synced' });
    const graph = await renderString(PAGE.datasources.users.transform, scope({}, { value: { value: ALL } }));
    for (const u of (graph as Def).value) {
      const mine = label(u);
      expect([mine.licenceState, mine.sourceLabel]).toEqual([u.licenceState, u.sourceLabel]);
    }
  });

  it('lists the first 10,000 in the browser; the export has every one', async () => {
    const many = Array.from({ length: 10_050 }, () => user({}));
    const matches = await view('inactiveMatches', { activity: 'Inactive90' }, { inactive: { value: many } });
    expect(matches.rows).toHaveLength(10_050);
    const list = await view('userList', { activity: 'Inactive90' }, { inactiveMatches: matches });
    expect(list).toMatchObject({ matched: 10_050, listCapped: true });
    expect(list.rows).toHaveLength(10_000);
    const exported = (params: Record<string, unknown>) => renderString(PAGE.export.data, scope(params));
    expect(await exported({ activity: 'Inactive90' })).toBe('inactiveMatches.rows');
    expect(await exported({ mfa: 'NotRegistered' })).toBe('registrations.value');
    expect(await exported({ mfa: 'NotRegistered', activity: 'Inactive90' })).toBe('registrations.value');
    expect(await exported({})).toBe('users.value');
  });

  it('says when the read stopped at its cap', async () => {
    expect((await inactiveView({}, { truncated: true })).partial).toBe(true);
    expect((await inactiveView({})).partial).toBe(false);
  });

  it('never sends the whole sign-in read to the browser', () => {
    const fetched = neededDatasources(PAGE, [
      activeBlocks(PAGE, undefined).blocks,
      PAGE.header,
      PAGE.actions,
    ]);
    expect(fetched).toEqual(expect.arrayContaining(['users', 'counts', 'userList', 'registrations']));
    for (const server of ['inactive', 'inactiveMatches']) expect(fetched).not.toContain(server);
  });
});
