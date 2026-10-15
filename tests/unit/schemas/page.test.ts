import { Param, registerWidgetSchema, RetryPolicy, WidgetBlockBase, type Page, type Report } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok, yaml } from './helpers';

const page = (body: string) => `${ENVELOPE('page', 'identity.example')}template: list-detail\n${body}`;
const TABLE = yaml`
  layout:
    - widget: table
      data: users.value
      columns:
        - { field: displayName, label: Name, kind: identity, secondary: userPrincipalName }
        - { field: accountEnabled, label: Status, kind: status, map: { "true": [ok, Enabled] }, filter: facet }
`;

describe('params', () => {
  it.each([
    { type: 'string', default: '', format: 'guid', picker: 'user', minLength: 1 },
    { type: 'number', default: 5, min: 0, integer: true },
    { type: 'boolean', default: '${ env.FLAG = "1" }' },
    { type: 'enum', values: ['All', { value: 30, label: '30 days' }], default: 'All', facet: true },
    { type: 'enum', values: ['a', 'b'], multiple: true, default: ['a'] },
    { type: 'date', default: '-30d' },
    { type: 'dateRange', presets: ['PT1H', 'P7D'], default: 'P7D' },
    { type: 'guid', required: true, hidden: true },
    { type: 'user', multiple: true, maxItems: 50 },
    { type: 'resource', resourceTypes: ['microsoft.web/sites'] },
    { type: 'subscription' },
  ])('accepts $type params', (p) => expect(Param.safeParse(p).success).toBe(true));
  it('rejects unknown types and bad values', () => {
    expect(Param.safeParse({ type: 'text' }).error!.issues[0]!.message).toMatch(/Expected 'string' \| 'number'/);
    expect(Param.safeParse({ type: 'enum', values: [] }).success).toBe(false);
    expect(Param.safeParse({ type: 'date', default: 'last month' }).success).toBe(false);
    expect(Param.safeParse({ type: 'guid', default: 'abc' }).success).toBe(false);
  });
  it('requires identifier param names (they are read from expressions)', () =>
    expect(brief(errors(page(`params:\n  user-type: { type: string }\n${TABLE}`)))).toEqual(['params.user-type@8']));
});

describe('page', () => {
  it('accepts a list page with datasources of every source', () => {
    const def = ok<Page>(
      page(yaml`
        params:
          q: { type: string }
        datasources:
          users: { source: graph, request: { path: /users }, paging: cursor, cache: { ttl: 60 } }
          counts: { source: graphBatch, requests: { members: { path: /users/$count } } }
          rgs: { source: arm, request: { path: /subscriptions, apiVersion: 2022-12-01 }, paging: all, maxItems: 500 }
          arc: { source: resourceGraph, query: "resources | take 5", subscriptions: "\${ params.subs }" }
          logs: { source: logAnalytics, workspace: "\${ env.AF_WORKSPACE_ID }", query: "AppRequests | take 5", timespan: P1D }
          hr: { source: function, connection: integrations.hr-sync, operation: listEmployees, pathParams: { id: x } }
          mbx: { source: runner, script: exchange/Get-MailboxForwarding.ps1, sha256: ${'a'.repeat(64)}, services: [exchange] }
          demo: { source: static, data: [1, 2, 3], transform: "\${ value[$ > 1] }", when: true }
      `) + TABLE,
    );
    expect(Object.keys(def.datasources!)).toHaveLength(8);
    expect(def.datasources!.users).toMatchObject({ paging: 'cursor' });
    expect(def.datasources!.counts).not.toHaveProperty('paging');
  });
  it.each([
    ['arm without apiVersion', 'x: { source: arm, request: { path: /subscriptions } }', 'datasources.x.request.apiVersion@8'],
    ['graph path without leading /', 'x: { source: graph, request: { path: users } }', 'datasources.x.request.path@8'],
    ['transform without ${ }', 'x: { source: static, data: 1, transform: value + 1 }', 'datasources.x.transform@8'],
    ['runner with a bad sha256', 'x: { source: runner, script: a.ps1, sha256: abc }', 'datasources.x.sha256@8'],
    ['unknown source', 'x: { source: sql, query: x }', 'datasources.x.source@8'],
    ['datasource name with a dash', 'my-ds: { source: static, data: 1 }', 'datasources.my-ds@8'],
  ])('rejects %s', (_label, ds, at) => expect(brief(errors(page(`datasources:\n  ${ds}\n${TABLE}`)))).toEqual([at]));

  it('validates table widgets (columns, actions) with paths and lines', () => {
    const e = errors(
      page(yaml`
        layout:
          - widget: table
            columns:
              - { field: displayName, label: Name }
              - { label: No field }
            rowActions:
              - { label: Both, playbook: identity.x, href: "https://example.com" }
            bulkActions:
              - { playbook: identity.x, label: Go, forEach: { inputs: { id: "\${ row.id }" }, concurrency: 20 } }
      `),
    );
    expect(brief(e)).toEqual(['layout[0].columns[1].field@11', 'layout[0].rowActions[0]@13', 'layout[0].bulkActions[0].forEach.concurrency@15']);
    expect(e[1]!.message).toMatch(/exactly one of playbook or href/);
  });
  it('keeps widget-specific config (passthrough) and applies table defaults', () => {
    const def = ok<Page>(page(`${TABLE}  - { widget: kpi, data: counts.members, label: Members, status: "\${ value > 0 ? 'warn' : 'ok' }" }\n`));
    expect(def.layout![1]).toEqual({ widget: 'kpi', data: 'counts.members', label: 'Members', status: "${ value > 0 ? 'warn' : 'ok' }" });
  });
  it('plugs in widget schemas registered by @adminforge/widgets', () => {
    registerWidgetSchema('gauge', WidgetBlockBase.extend({ max: RetryPolicy.shape.max }));
    expect(brief(errors(page(`layout:\n  - { widget: gauge, max: high }\n`)))).toEqual(['layout[0].max@8']);
  });
  it('checks filters and export against params and datasources', () => {
    const e = errors(page(`params:\n  q: { type: string }\nfilters:\n  search: q\n  facets: [q, nope]\nexport: { formats: [csv], data: missing.value }\n${TABLE}`));
    expect(brief(e)).toEqual(['filters.facets[1]@11', 'export.data@12']);
  });
  it('requires a layout or tabs', () => expect(errors(page(''))[0]).toMatchObject({ path: 'layout', message: expect.stringMatching(/at least one widget/) }));
  it('accepts entity pages with header, tabs and actions', () =>
    expect(
      ok<Page>(
        `${ENVELOPE('page')}template: entity\nheader: { title: "\${ user.displayName }", ids: { Object id: "\${ user.id }" } }\nactions:\n  - { playbook: identity.x, inputs: { id: "\${ params.id }" } }\ntabs:\n  - id: overview\n    label: Overview\n    layout: [{ widget: keyValue, data: user }]\n`,
      ).tabs,
    ).toHaveLength(1));
  it('rejects unknown templates', () => expect(brief(errors(page(TABLE).replace('list-detail', 'grid')))).toEqual(['template@6']));
  it('accepts the full filter bar and saved views', () =>
    expect(
      ok<Page>(
        page(
          `params:\n  q: { type: string }\n  adv: { type: string, hidden: true }\nfilters:\n  search: q\n  advanced: { dialect: odata, param: adv, fields: [{ field: department, label: Department, type: string, operators: [eq, startsWith] }] }\nsavedViews:\n  presets: [{ name: Mine, params: { q: me } }]\n${TABLE}`,
        ),
      ).savedViews,
    ).toEqual({ enabled: true, shared: true, presets: [{ name: 'Mine', params: { q: 'me' } }] }));
});

describe('dashboard and report', () => {
  it('defaults the dashboard template', () =>
    expect(ok(`${ENVELOPE('dashboard', 'overview.tenant')}nav: { section: overview, order: 1 }\nlayout:\n  - { widget: kpi, span: 3, rows: 1 }\n`)).toMatchObject({ template: 'dashboard' }));
  it('rejects spans outside the 12-column grid', () =>
    expect(brief(errors(`${ENVELOPE('dashboard')}layout:\n  - { widget: kpi, span: 13 }\n`))).toEqual(['layout[0].span@7']));
  it('requires export on reports', () => {
    expect(brief(errors(`${ENVELOPE('report')}${TABLE}`))).toEqual(['export@1']);
    const def = ok<Report>(`${ENVELOPE('report')}${TABLE}export: { formats: [csv, xlsx], fileName: "users-\${ params.days }d" }\n`);
    expect(def).toMatchObject({ template: 'report', export: { formats: ['csv', 'xlsx'] } });
  });
  it('rejects unknown export formats', () =>
    expect(brief(errors(`${ENVELOPE('report')}${TABLE}export: { formats: [pdf] }\n`))).toEqual(['export.formats[0]@12']));
});
