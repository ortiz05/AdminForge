import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { activeBlocks, neededDatasources } from '@adminforge/web/src/renderer/page-model';
import { repoRoot } from '../lib/repo';

// The Groups page's views (docs/plans/2026-10-22-group-and-user-views.md): owners, age, paused rules and renewal are
// Graph filters on the page's own list; the member views read every group with its members expanded (Graph can't
// filter on member count) and apply the page's facets natively, labelled by partition — no JSONata per group. Fleet
// size: content-at-scale-groups-views.scale.test.ts.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const PAGE: Def = loaded.definitions.find((d) => d.def.id === 'identity.groups')!.def;
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
  renderString(PAGE.datasources.groups.request.query.$filter, { ...scope(params), advanced: '' });
const when = (ds: string, params: Record<string, unknown>) =>
  renderString(PAGE.datasources[ds].when, scope(params));
/** A static datasource as the executor runs it: its `data` over its dependencies, then its transform (which sees them too). */
async function view(
  name: string,
  params: Record<string, unknown>,
  ds: Record<string, unknown>,
): Promise<Def> {
  const d = PAGE.datasources[name];
  const value = typeof d.data === 'string' ? await renderString(d.data, scope(params, { ds })) : d.data;
  return renderString(d.transform, scope(params, { value, ds }));
}
/** The member read as Graph answers it (members expanded), through its own transform. */
const everyGroupFrom = (groups: Def[], extra: Record<string, unknown> = {}) =>
  renderString(
    PAGE.datasources.everyGroup.transform,
    scope({}, { value: { value: groups, ...extra } }),
  ) as Promise<Def>;

let n = 0;
const group = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  displayName: `Group ${n}`,
  description: null,
  mail: null,
  mailEnabled: false,
  securityEnabled: true,
  groupTypes: [],
  membershipRuleProcessingState: null,
  onPremisesSyncEnabled: null,
  isAssignableToRole: false,
  createdDateTime: '2024-01-15T09:00:00Z',
  renewedDateTime: '2024-01-15T09:00:00Z',
  expirationDateTime: null,
  members: [],
  ...over,
});
const members = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));

const SECURITY = group({ displayName: 'Finance Approvers', members: members(2) });
const M365 = group({
  displayName: 'Project Falcon',
  groupTypes: ['Unified'],
  mailEnabled: true,
  members: members(7),
});
const MAIL_SEC = group({ displayName: 'Mail Security', mailEnabled: true, members: members(0) });
const DL = group({
  displayName: 'All Staff DL',
  securityEnabled: false,
  mailEnabled: true,
  members: members(4),
});
const DYNAMIC = group({
  displayName: 'Dynamic Sales',
  groupTypes: ['DynamicMembership'],
  membershipRuleProcessingState: 'Paused',
  members: members(1),
});
const SYNCED = group({ displayName: 'AD Synced Ops', onPremisesSyncEnabled: true, members: members(3) });
const NEW = group({ displayName: 'New Team', createdDateTime: '2026-10-10T09:00:00Z', members: members(0) });
const ROLE = group({ displayName: 'Tier 0 Admins', isAssignableToRole: true, members: members(20) });
const OLD_M365 = group({
  displayName: 'Old Workspace',
  groupTypes: ['Unified'],
  mailEnabled: true,
  renewedDateTime: '2025-03-01T09:00:00Z',
  expirationDateTime: '2026-11-05T09:00:00Z',
  members: members(1),
});
const ALL = [SECURITY, M365, MAIL_SEC, DL, DYNAMIC, SYNCED, NEW, ROLE, OLD_M365];
const memberView = async (
  params: Record<string, unknown>,
  owners: Def[] = [],
  extra: Record<string, unknown> = {},
) =>
  view(
    'memberMatches',
    { members: 'UnderFive', ...params },
    {
      everyGroup: await everyGroupFrom(ALL, extra),
      ownerIds: { value: owners.map((g) => ({ id: g.id })) },
    },
  );
const names = (rows: Def[]) => rows.map((r) => r.displayName).sort();

describe('identity.groups — views Graph filters', () => {
  it.each([
    [{ owners: 'None' }, 'owners/$count eq 0'],
    [{ owners: 'One' }, 'owners/$count eq 1'],
    [{ created: 'Last30Days' }, 'createdDateTime ge 2026-09-22T12:00:00.000Z'],
    [{ created: 'OverAYear' }, 'createdDateTime le 2025-10-22T12:00:00.000Z'],
    [
      { membership: 'Paused' },
      "groupTypes/any(c:c eq 'DynamicMembership') and membershipRuleProcessingState eq 'Paused'",
    ],
    [{ lifecycle: 'Expiring' }, 'expirationDateTime le 2026-11-21T12:00:00.000Z'],
    [
      { lifecycle: 'NotRenewed' },
      "groupTypes/any(c:c eq 'Unified') and renewedDateTime le 2025-10-22T12:00:00.000Z",
    ],
  ])('%o filters on %s', async (params, clause) => {
    expect(await filter(params)).toBe(clause);
  });

  it('combines a view with the other facets in one query', async () => {
    expect(await filter({ kind: 'Security', owners: 'None' })).toBe(
      'securityEnabled eq true and mailEnabled eq false and owners/$count eq 0',
    );
  });

  it('reads the dates the renewal views show', () => {
    expect(PAGE.datasources.groups.request.query.$select).toMatch(
      /\brenewedDateTime\b.*\bexpirationDateTime\b/,
    );
  });

  it('ships a preset for every view, naming only declared params and values', () => {
    const presets = PAGE.savedViews.presets as Array<{ name: string; params: Record<string, unknown> }>;
    for (const want of [
      'No owners',
      'One owner',
      'No members',
      'Fewer than 5 members',
      'Created in the last 30 days',
      'Created over a year ago',
      'Paused dynamic rules',
      'Microsoft 365 groups expiring in 30 days',
      'Microsoft 365 groups not renewed in a year',
    ])
      expect(presets.map((p) => p.name)).toContain(want);
    for (const p of presets)
      for (const [k, v] of Object.entries(p.params)) {
        const param = PAGE.params[k];
        expect(param, `${p.name}: ${k}`).toBeDefined();
        const values = (param.values as Array<string | { value: string }>).map((x) =>
          typeof x === 'string' ? x : x.value,
        );
        expect(values, `${p.name}: ${k}=${String(v)}`).toContain(v);
      }
  });

  it('explains in the owner views that Graph counts apps as owners, with the report that tells them apart', async () => {
    const note = PAGE.layout.find((b: Def) => b.id === 'ownersNote');
    expect(note.text).toContain('/p/identity.groups-without-owners');
    const shows = (params: Record<string, unknown>) => renderString(note.when, scope(params));
    expect(await shows({ owners: 'None' })).toBe(true);
    expect(await shows({ owners: 'One', members: 'UnderFive' })).toBe(true);
    expect(await shows({})).toBe(false);
  });

  it('offers every new view as a facet', () => {
    expect(PAGE.filters.facets).toEqual(
      expect.arrayContaining(['owners', 'members', 'created', 'lifecycle']),
    );
  });
});

describe('identity.groups — member views', () => {
  it('switches the list: the member read and table on, the Graph list off', async () => {
    for (const members of ['None', 'UnderFive']) {
      expect(await when('everyGroup', { members })).toBe(true);
      expect(await when('groupList', { members })).toBe(true);
      expect(await when('groups', { members })).toBe(false);
    }
    expect(await when('everyGroup', {})).toBe(false);
    expect(await when('groups', {})).toBe(true);
    expect(await when('ownerIds', { members: 'UnderFive' })).toBe(false);
    expect(await when('ownerIds', { members: 'UnderFive', owners: 'None' })).toBe(true);
    expect(await when('ownerIds', { owners: 'None' })).toBe(false);
  });

  it('counts members as the read arrives and keeps only the fields the views use', async () => {
    const out = await everyGroupFrom([DL, ROLE], { truncated: true });
    expect(out.truncated).toBe(true);
    // Only groups under 5 members go on (both member views are subsets of them).
    expect(out.rows.map((r: Def) => r.memberCount)).toEqual([4]);
    for (const r of out.rows) expect(r).not.toHaveProperty('members');
  });

  it('reads members expanded without an advanced query (Graph refuses $expand in one)', () => {
    const req = PAGE.datasources.everyGroup.request;
    expect(req.query.$expand).toBe('members($select=id)');
    expect(req.headers?.ConsistencyLevel).toBeUndefined();
    expect(req.query.$count).toBeUndefined();
    expect(PAGE.datasources.everyGroup.maxItems).toBe(50_000);
  });

  it('keeps groups with fewer than 5 direct members, or none, with the count on each row', async () => {
    const under = await memberView({});
    expect(names(under.rows)).toEqual(names([SECURITY, MAIL_SEC, DL, DYNAMIC, SYNCED, NEW, OLD_M365]));
    expect(under.rows.find((r: Def) => r.id === DL.id).memberCount).toBe(4);
    const none = await memberView({ members: 'None' });
    expect(names(none.rows)).toEqual(names([MAIL_SEC, NEW]));
  });

  it('applies each facet natively as Graph would', async () => {
    const pick = async (params: Record<string, unknown>) => names((await memberView(params)).rows);
    expect(await pick({ kind: 'Security' })).toEqual(names([SECURITY, DYNAMIC, SYNCED, NEW]));
    expect(await pick({ kind: 'Microsoft365' })).toEqual(names([OLD_M365]));
    expect(await pick({ kind: 'MailSecurity' })).toEqual(names([MAIL_SEC]));
    expect(await pick({ kind: 'Distribution' })).toEqual(names([DL]));
    expect(await pick({ membership: 'Dynamic' })).toEqual(names([DYNAMIC]));
    expect(await pick({ membership: 'Paused' })).toEqual(names([DYNAMIC]));
    expect(await pick({ membership: 'Assigned' })).not.toContain('Dynamic Sales');
    expect(await pick({ source: 'Synced' })).toEqual(names([SYNCED]));
    expect(await pick({ source: 'Cloud' })).not.toContain('AD Synced Ops');
    expect(await pick({ roleAssignable: 'Yes' })).toEqual([]);
    expect(await pick({ members: 'None', roleAssignable: 'No' })).toEqual(names([MAIL_SEC, NEW]));
    expect(await pick({ created: 'Last30Days' })).toEqual(names([NEW]));
    expect(await pick({ lifecycle: 'Expiring' })).toEqual(names([OLD_M365]));
    expect(await pick({ lifecycle: 'NotRenewed' })).toEqual(names([OLD_M365]));
    expect(await pick({ q: 'staff' })).toEqual(names([DL]));
    expect(await pick({ q: 'x'.repeat(300) })).toEqual([]);
  });

  it('keeps the owner views over the member read: the ids Graph counted', async () => {
    const none = await memberView({ owners: 'None' }, [SECURITY, NEW]);
    expect(names(none.rows)).toEqual(names([SECURITY, NEW]));
    const one = await memberView({ owners: 'One' }, [DL]);
    expect(names(one.rows)).toEqual(names([DL]));
  });

  it('labels type, membership and source as the Graph list does', async () => {
    const rows = (await memberView({ members: 'None' })).rows.concat((await memberView({})).rows);
    const label = (g: Def) => rows.find((r: Def) => r.id === g.id);
    expect(label(SECURITY)).toMatchObject({ kind: 'Security', membership: 'Assigned', sourceLabel: 'Cloud' });
    expect(label(OLD_M365)).toMatchObject({ kind: 'Microsoft 365' });
    expect(label(MAIL_SEC)).toMatchObject({ kind: 'Mail-enabled security' });
    expect(label(DL)).toMatchObject({ kind: 'Distribution' });
    expect(label(DYNAMIC)).toMatchObject({ membership: 'Dynamic' });
    expect(label(SYNCED)).toMatchObject({ sourceLabel: 'Synced' });
    // The Graph list's own transform labels the same raw rows the same way.
    const graph = await renderString(PAGE.datasources.groups.transform, scope({}, { value: { value: ALL } }));
    for (const g of (graph as Def).value) {
      const mine = label(g);
      if (mine)
        expect([mine.kind, mine.membership, mine.sourceLabel]).toEqual([g.kind, g.membership, g.sourceLabel]);
    }
  });

  it('lists the first 10,000 matches in the browser; the export has every one', async () => {
    const many = Array.from({ length: 10_050 }, () => group({ members: members(1) }));
    const matches = await view(
      'memberMatches',
      { members: 'UnderFive' },
      { everyGroup: await everyGroupFrom(many) },
    );
    expect(matches.rows).toHaveLength(10_050);
    const list = await view('groupList', { members: 'UnderFive' }, { memberMatches: matches });
    expect(list).toMatchObject({ matched: 10_050, listCapped: true });
    expect(list.rows).toHaveLength(10_000);
    expect(await renderString(PAGE.export.data, scope({ members: 'UnderFive' }))).toBe('memberMatches.rows');
    expect(await renderString(PAGE.export.data, scope({}))).toBe('groups.value');
  });

  it('lists the fewest members first, then by name', async () => {
    const matches = await memberView({});
    const list = await view('groupList', { members: 'UnderFive' }, { memberMatches: matches });
    const counts = list.rows.map((r: Def) => r.memberCount);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => a - b));
    expect(list.rows.slice(0, 2).map((r: Def) => r.displayName)).toEqual(['Mail Security', 'New Team']);
  });

  it('says when a read stopped at its cap', async () => {
    expect((await memberView({}, [], { truncated: true })).partial).toBe(true);
    expect((await memberView({})).partial).toBe(false);
  });

  it('never sends the member read to the browser, and skips the Graph list in a member view', () => {
    const fetched = neededDatasources(PAGE, [
      activeBlocks(PAGE, undefined).blocks,
      PAGE.header,
      PAGE.actions,
    ]);
    expect(fetched).toEqual(expect.arrayContaining(['groups', 'counts', 'groupList']));
    for (const server of ['everyGroup', 'ownerIds', 'memberMatches']) expect(fetched).not.toContain(server);
  });
});
