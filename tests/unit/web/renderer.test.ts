import type { Params } from '@adminforge/schemas';
import { featureKeyFor, loadDatasource, type Capabilities, type PageDefinition } from '@adminforge/web/src/renderer/api';
import { fileNameFrom } from '@adminforge/web/src/renderer/ExportMenu';
import { activeBlocks, licenceState, neededDatasources, tableColumns, withIds } from '@adminforge/web/src/renderer/page-model';
import { coerceParam, isDefault, isNeutralOption, paramsToSearch, resolveParams } from '@adminforge/web/src/renderer/params';
import {
  pageSearch,
  readInspect,
  readTableView,
  sanitizeSearch,
  tableNamespaces,
  tableSearch,
  tableViewToSearch,
  withInspect,
  withoutInspect,
} from '@adminforge/web/src/renderer/url-state';
import { sameState } from '@adminforge/web/src/renderer/ViewsMenu';
import { advancedParamOf, countConditions, decodeFilter, draftFromWire, draftToWire, encodeFilter, paramIssues, placeServerIssues } from '@adminforge/web/src/renderer/QueryBuilder';
import { contentKeyOf, splitHref } from '@adminforge/web/src/lib/links';
import { requiresText } from '@adminforge/web/src/app/NavRail';

const PARAMS: Params = {
  q: { type: 'string', default: '' },
  userType: { type: 'enum', values: ['All', 'Member', 'Guest'], default: 'All', facet: true },
  days: { type: 'enum', values: [{ value: 30, label: '30 days' }, { value: 90, label: '90 days' }], default: 30 },
  includeExpired: { type: 'boolean', default: true },
  top: { type: 'number', min: 1, max: 999 },
  id: { type: 'guid', hidden: true },
  when: { type: 'dateRange', presets: ['P1D', 'P7D'], default: 'P7D' },
  tags: { type: 'enum', values: ['a', 'b', 'c'], multiple: true },
};

describe('page params ↔ URL', () => {
  it('coerces URL values by type and reports what was wrong', () => {
    expect(coerceParam(PARAMS.days!, '90')).toEqual([90]);
    expect(coerceParam(PARAMS.includeExpired!, 'false')).toEqual([false]);
    expect(coerceParam(PARAMS.top!, '2000')[1]).toMatch(/above 999/);
    expect(coerceParam(PARAMS.id!, 'not-a-guid')[1]).toMatch(/GUID/);
    expect(coerceParam(PARAMS.userType!, 'Robot')[1]).toMatch(/not one of/);
    expect(coerceParam(PARAMS.tags!, 'a,c')).toEqual([['a', 'c']]);
    expect(coerceParam(PARAMS.when!, { from: '2026-10-01', to: '2026-10-02' })).toEqual([{ from: '2026-10-01', to: '2026-10-02' }]);
  });

  it('resolves display values (with literal defaults) apart from what is sent to the BFF', () => {
    const r = resolveParams(PARAMS, { userType: 'Guest', days: 'x', top: 50 });
    expect(r.values).toMatchObject({ q: '', userType: 'Guest', days: 30, includeExpired: true, top: 50, when: 'P7D' });
    expect(r.send).toEqual({ userType: 'Guest', top: 50 });
    expect(Object.keys(r.issues)).toEqual(['days']);
  });

  it('drops defaults and blanks from the URL', () => {
    expect(paramsToSearch(PARAMS, { userType: 'All', days: 90, q: '', tags: [] })).toEqual({ userType: undefined, days: 90, q: undefined, tags: undefined });
    expect(isDefault(PARAMS.days!, '30')).toBe(true);
    expect(isNeutralOption(PARAMS.userType!, 'All')).toBe(true);
    expect(isNeutralOption(PARAMS.days!, 30)).toBe(false);
  });
});

describe('table state ↔ URL', () => {
  const cols = { all: ['displayName', 'userType', 'jobTitle', 'id'], visible: ['displayName', 'userType', 'jobTitle'] };

  it('round-trips sort, visible columns + order, density, search and client filters', () => {
    const view = {
      sorting: [{ id: 'displayName', desc: true }, { id: 'userType', desc: false }],
      columnOrder: ['userType', 'displayName', 'jobTitle', 'id'],
      columnVisibility: { jobTitle: false, id: true },
      density: 'compact' as const,
      globalFilter: 'lee',
      columnFilters: [{ id: 'userType', value: ['Guest'] }, { id: 'lastSignIn', value: 'older:90d' }],
    };
    const patch = tableViewToSearch('users', view, cols);
    expect(patch).toEqual({
      'users.sort': '-displayName,userType',
      'users.cols': 'userType,displayName,id',
      'users.density': 'compact',
      'users.q': 'lee',
      'users.f': { userType: ['Guest'], lastSignIn: 'older:90d' },
    });
    const back = readTableView(patch, 'users', cols.all)!;
    expect(back.sorting).toEqual(view.sorting);
    expect(back.columnVisibility).toEqual({ displayName: true, userType: true, jobTitle: false, id: true });
    expect(back.columnOrder).toEqual(['userType', 'displayName', 'id']);
    expect(back.columnFilters).toEqual(view.columnFilters);
  });

  it('writes nothing for the defaults', () => {
    expect(tableViewToSearch('users', {}, cols)).toEqual({
      'users.sort': undefined,
      'users.cols': undefined,
      'users.density': undefined,
      'users.q': undefined,
      'users.f': undefined,
    });
    expect(readTableView({}, 'users')).toBeUndefined();
  });

  it('splits the search into page params, table keys and reserved keys', () => {
    const search = { userType: 'Guest', 'users.sort': 'displayName', view: 'v1', tab: 'groups', inspect: 'page:identity.user', 'i.id': 'x', playbook: 'identity.disable-user' };
    expect(pageSearch(search)).toEqual({ userType: 'Guest' });
    expect(tableSearch(search)).toEqual({ 'users.sort': 'displayName' });
    expect(tableNamespaces(search)).toEqual(['users']);
  });

  it('sanitises the generic search object', () => {
    const out = sanitizeSearch({ a: 'x'.repeat(70_000), b: [1, 'two', { no: true }], c: { from: 'a', to: 'b' }, d: null });
    expect((out.a as string).length).toBe(64 * 1024);
    expect(out.b).toEqual([1, 'two']);
    expect(out.c).toEqual({ from: 'a', to: 'b' });
    expect('d' in out).toBe(false);
  });
});

describe('inspector URL', () => {
  it('opens an entity page with i.* params and closes cleanly', () => {
    const prev = { userType: 'Guest', inspect: 'user:abc', 'i.old': 1, itab: 'groups' };
    const next = withInspect(prev, { page: 'identity.user', params: { id: '0a1b', empty: '' } });
    expect(next).toEqual({ userType: 'Guest', inspect: 'page:identity.user', 'i.id': '0a1b' });
    expect(readInspect(next)).toEqual({ page: 'identity.user', params: { id: '0a1b' } });
    expect(withoutInspect({ ...next, itab: 'roles' })).toEqual({ userType: 'Guest' });
    expect(readInspect({ inspect: 'user:abc' })).toBeNull();
    expect(readInspect({ inspect: 'page:Not A Key' })).toBeNull();
  });
});

const def = (over: Partial<PageDefinition>): PageDefinition =>
  ({ kind: 'page', id: 'test.page', version: '1.0.0', title: 'Test', owner: 'x', template: 'list-detail', ...over }) as PageDefinition;

describe('page model', () => {
  it('requests only the datasources the visible blocks and templates use', () => {
    const d = def({
      datasources: {
        users: { source: 'static', data: [] },
        counts: { source: 'static', data: {} },
        delta: { source: 'static', data: {} },
        unused: { source: 'static', data: 1 },
        profile: { source: 'static', data: {} },
      } as PageDefinition['datasources'],
    });
    const blocks = [
      { widget: 'kpi', data: 'counts.members', delta: 'delta.members', label: 'M' },
      { widget: 'table', data: 'users.value', columns: [{ field: 'a', label: 'A' }] },
    ];
    expect(neededDatasources(d, [blocks, { title: '${ profile.displayName }' }])).toEqual(['users', 'counts', 'delta', 'profile']);
  });

  it('picks the active tab and gives blocks stable ids', () => {
    const d = def({
      template: 'entity',
      tabs: [
        { id: 'overview', label: 'Overview', layout: [{ widget: 'markdown', text: 'a' }] },
        { id: 'groups', label: 'Groups', layout: [{ widget: 'table', data: 'g.value', columns: [{ field: 'displayName', label: 'Group' }, { field: 'id', label: 'Id', hidden: true }] }] },
      ],
    });
    expect(activeBlocks(d, undefined).tab).toBe('overview');
    const groups = activeBlocks(d, 'groups');
    expect(groups.blocks[0]!.id).toBe('groups_table0');
    expect(tableColumns(groups.blocks)).toEqual({ groups_table0: { all: ['displayName', 'id'], visible: ['displayName'] } });
    expect(withIds([{ widget: 'kpi', id: 'mine' }])[0]!.id).toBe('mine');
  });

  it('gates only when every declared licence is known to be missing', () => {
    const caps: Capabilities = {
      features: {
        intune: { available: false, label: 'Microsoft Intune', sku: 'INTUNE_A', servicePlans: ['INTUNE_A'] },
        signInLogs: { available: true, label: 'Sign-in logs' },
        pim: { available: null, label: 'PIM' },
      },
    };
    expect(licenceState(def({ requires: { licences: ['intune'] } }), caps).missing.map((m) => m.key)).toEqual(['intune']);
    expect(licenceState(def({ requires: { licences: ['INTUNE_A'] } }), caps).missing.map((m) => m.key)).toEqual(['intune']);
    expect(licenceState(def({ requires: { licences: ['intune', 'signInLogs'] } }), caps).missing).toEqual([]);
    expect(licenceState(def({ requires: { licences: ['pim'] } }), caps).missing).toEqual([]);
    expect(licenceState(def({ requires: { licences: ['SOMETHING_ELSE'] } }), caps).missing).toEqual([]);
    expect(licenceState(def({ requires: { licences: ['intune'] } }), undefined).missing).toEqual([]);
    expect(featureKeyFor('Intune', caps)).toBe('intune');
  });
});

describe('BFF calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('batches datasource loads that start together into one execute-many', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { datasources: string[] };
      return new Response(
        JSON.stringify({
          results: Object.fromEntries(
            body.datasources.map((d) => [d, d === 'bad' ? { error: { code: 'forbidden', message: 'No.' } } : { data: { value: [d] }, provenance: { service: 'graph', path: `/${d}`, ms: 5 }, cursor: d === 'a' ? 'next' : undefined }]),
          ),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const [a, b, bad] = await Promise.all([
      loadDatasource('test.page', '1.0.0', { x: 1 }, 'a'),
      loadDatasource('test.page', '1.0.0', { x: 1 }, 'b'),
      loadDatasource('test.page', '1.0.0', { x: 1 }, 'bad'),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ page: 'test.page', version: '1.0.0', datasources: ['a', 'b', 'bad'], params: { x: 1 } });
    expect(a).toMatchObject({ data: { value: ['a'] }, cursor: 'next', provenance: { path: '/a' } });
    expect(b.cursor).toBeUndefined();
    expect(bad.error).toMatchObject({ code: 'forbidden', message: 'No.' });
  });
});

describe('small helpers', () => {
  it('reads export file names from Content-Disposition', () => {
    expect(fileNameFrom(`attachment; filename="users.csv"; filename*=UTF-8''users%20(1).csv`)).toBe('users (1).csv');
    expect(fileNameFrom('attachment; filename="report.xlsx"')).toBe('report.xlsx');
    expect(fileNameFrom(null)).toBeUndefined();
  });

  it('compares saved-view states ignoring key order and blanks', () => {
    expect(sameState({ params: { a: 1, b: '' }, table: {} }, { params: { a: 1 }, table: {} })).toBe(true);
    expect(sameState({ params: { a: 1 }, table: { 'u.sort': 'x' } }, { params: { a: 1 }, table: {} })).toBe(false);
  });

  it('splits hrefs and recognises content pages', () => {
    expect(splitHref('/p/identity.users?userType=Guest&days=30#x')).toEqual({ pathname: '/p/identity.users', search: { userType: 'Guest', days: 30 }, hash: 'x' });
    expect(contentKeyOf('/p/identity.users')).toBe('identity.users');
    expect(contentKeyOf('/runs')).toBeNull();
  });

  it('shortens "Requires …" nav badges to friendly licence names', () => {
    expect(requiresText('Requires INTUNE_A or EMS')).toBe('Intune');
    expect(requiresText('Requires AAD_PREMIUM_P2')).toBe('Entra P2');
    expect(requiresText('Requires signInLogs')).toBe('Entra P1');
    expect(requiresText('3')).toBeNull();
  });
});

describe('advanced filter (structured, compiled by the BFF)', () => {
  const spec = {
    dialect: 'odata' as const,
    fields: [
      { field: 'department', label: 'Department', type: 'string' as const, operators: ['eq' as const, 'startsWith' as const, 'isEmpty' as const] },
      { field: 'createdDateTime', label: 'Created', type: 'date' as const, operators: ['ge' as const, 'le' as const] },
      { field: 'onPremisesSyncEnabled', label: 'Synced', type: 'boolean' as const, operators: ['eq' as const] },
      { field: 'profileType', label: 'Profile type', type: 'enum' as const, values: ['RegisteredDevice', 'Printer'] },
      { field: 'tagCount', label: 'Tags', type: 'number' as const, operators: ['eq' as const, 'lt' as const, 'gt' as const] },
      { field: 'subscriptionId', label: 'Subscription', type: 'guid' as const, operators: ['eq' as const, 'in' as const] },
    ],
  };
  const cond = (field: string, op: string, text = '', picks: string[] = []) => ({ kind: 'condition' as const, field, op: op as never, text, picks });

  it('uses filters.advanced.param, defaulting to adv', () => {
    expect(advancedParamOf(spec)).toBe('adv');
    expect(advancedParamOf({ ...spec, param: 'where' })).toBe('where');
  });

  it('types every value per field and nests one group level', () => {
    const r = draftToWire(spec, {
      join: 'all',
      items: [
        cond('department', 'startsWith', '  IT '),
        cond('createdDateTime', 'ge', '-30d'),
        cond('onPremisesSyncEnabled', 'eq', '', ['true']),
        cond('department', 'isEmpty'),
        { kind: 'group', join: 'any', items: [cond('profileType', 'in', '', ['Printer', 'RegisteredDevice']), cond('tagCount', 'lt', '3')] },
        cond('subscriptionId', 'in', '0A1B2C3D-0000-4000-8000-000000000001, 0a1b2c3d-0000-4000-8000-000000000002'),
      ],
    });
    expect(r.problems).toEqual({ byCondition: {}, general: [] });
    expect(r.filter).toEqual({
      all: [
        { field: 'department', op: 'startsWith', value: 'IT' },
        { field: 'createdDateTime', op: 'ge', value: '-30d' },
        { field: 'onPremisesSyncEnabled', op: 'eq', value: true },
        { field: 'department', op: 'isEmpty' },
        { any: [{ field: 'profileType', op: 'in', value: ['Printer', 'RegisteredDevice'] }, { field: 'tagCount', op: 'lt', value: 3 }] },
        { field: 'subscriptionId', op: 'in', value: ['0a1b2c3d-0000-4000-8000-000000000001', '0a1b2c3d-0000-4000-8000-000000000002'] },
      ],
    });
  });

  it('reports problems per condition (and the 20-condition cap) instead of sending them', () => {
    const r = draftToWire(spec, {
      join: 'any',
      items: [
        cond('tagCount', 'gt', 'ten'),
        cond('createdDateTime', 'ge', 'last week'),
        cond('department', 'eq', 'x'.repeat(257)),
        cond('department', 'contains', 'a'),
        { kind: 'group', join: 'all', items: [cond('subscriptionId', 'eq', 'nope')] },
      ],
    });
    expect(r.filter).toBeUndefined();
    expect(Object.keys(r.problems.byCondition)).toEqual(['0', '1', '2', '3', '4.0']);
    expect(r.problems.byCondition['3']).toMatch(/doesn’t support/);
    const many = draftToWire(spec, { join: 'all', items: Array.from({ length: 21 }, () => cond('department', 'eq', 'a')) });
    expect(many.problems.general).toEqual(['Use at most 20 conditions.']);
    const tooManyValues = draftToWire(spec, { join: 'all', items: [cond('subscriptionId', 'in', Array.from({ length: 51 }, () => '0a1b2c3d-0000-4000-8000-000000000001').join(','))] });
    expect(tooManyValues.problems.byCondition['0']).toMatch(/at most 50/);
  });

  it('round-trips through the URL (base64url JSON) and back into the form', () => {
    const filter = { any: [{ field: 'department', op: 'eq' as const, value: 'Ünïcode & co' }, { all: [{ field: 'tagCount', op: 'gt' as const, value: 2 }] }] };
    const encoded = encodeFilter(filter);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilter(encoded)).toEqual(filter);
    expect(decodeFilter(JSON.stringify(filter))).toEqual(filter);
    expect(decodeFilter('not-a-filter')).toBeUndefined();
    expect(decodeFilter({ all: [], extra: 1 })).toBeUndefined();
    expect(countConditions(filter)).toBe(2);
    const draft = draftFromWire(spec, filter);
    expect(draft.join).toBe('any');
    expect(draft.items[1]).toMatchObject({ kind: 'group', join: 'all', items: [{ field: 'tagCount', op: 'gt', text: '2' }] });
    expect(draftToWire(spec, draft).filter).toEqual(filter);
  });

  it('reads every problem from a 400 invalid_params message, per param', () => {
    const message =
      'Invalid parameters: adv: createdDateTime ge: expects an ISO date or today, now, -30d; adv: unknown field "x"; userType: is not one of All, Member, Guest; adv: is not a valid filter (root: bad; all.0: worse)';
    expect(paramIssues(message, ['userType', 'adv'])).toEqual({
      adv: ['createdDateTime ge: expects an ISO date or today, now, -30d', 'unknown field "x"', 'is not a valid filter (root: bad; all.0: worse)'],
      userType: ['is not one of All, Member, Guest'],
    });
  });
});

describe('server issues next to their conditions', () => {
  it('places "field op: message" on the matching condition and keeps the rest general', () => {
    const draft = {
      join: 'all' as const,
      items: [
        { kind: 'condition' as const, field: 'department', op: 'eq' as const, text: 'x', picks: [] },
        { kind: 'group' as const, join: 'any' as const, items: [{ kind: 'condition' as const, field: 'createdDateTime', op: 'ge' as const, text: 'soon', picks: [] }] },
      ],
    };
    expect(placeServerIssues(draft, ['createdDateTime ge: expects an ISO date or today, now, -30d', 'unknown field "nope"'])).toEqual({
      byCondition: { '1.0': 'Expects an ISO date or today, now, -30d' },
      general: ['unknown field "nope"'],
    });
  });
});
