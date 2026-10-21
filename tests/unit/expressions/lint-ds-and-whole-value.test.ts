import { lintExpressions } from '@adminforge/expressions';

// S-13: `ds.<name>` is user data when that datasource's own result can carry it — a Microsoft response (tenant data,
// like `value` in a transform), or a static/transform result built from params without an encoder — and only in the
// fields that do (the cost reports' `ds.scope.path` is encoded in its transform and stays clean). A whole-value request
// `path` / `url` may come straight from a param only when it is a guid or an entity id; a whole-value KQL `query` taken
// from the person needs the explicit opt-in `/* adminforge: user-query */`.
const paths = (def: unknown) => lintExpressions(def).map((i) => i.path);

/** The scope datasource of reports/azure/monthly-cost.report.yaml (and the billing reports). */
const SCOPE_TRANSFORM = `\${ (
  $sub := params.subscriptionId;
  $sub ? {
    'kind': 'subscription',
    'label': 'Subscription ' & $sub,
    'path': '/subscriptions/' & $encode($guid($sub))
  } : params.managementGroupId ? {
    'kind': 'managementGroup',
    'label': 'Management group ' & params.managementGroupId,
    'path': '/providers/Microsoft.Management/managementGroups/' & $encode(params.managementGroupId)
  } : { 'kind': 'none', 'missing': 'Set AF_COST_MANAGEMENT_GROUP_ID.' }
) }`;

const costReport = (use: string) => ({
  params: { subscriptionId: { type: 'subscription' }, managementGroupId: { type: 'string' } },
  datasources: {
    scope: { source: 'static', data: {}, transform: SCOPE_TRANSFORM },
    cost: {
      source: 'arm',
      request: { method: 'POST', path: use, apiVersion: '2023-11-01' },
    },
  },
});

describe('lint: datasource results', () => {
  it("keeps the cost reports' ${ ds.scope.path } clean", () => {
    expect(
      lintExpressions(costReport('${ ds.scope.path }/providers/Microsoft.CostManagement/query')),
    ).toEqual([]);
    expect(lintExpressions(costReport('${ ds.scope.path }'))).toEqual([]);
  });

  it('flags a field of the same datasource that carries the param as it came', () => {
    expect(paths(costReport('${ ds.scope.label }/providers/Microsoft.CostManagement/query'))).toEqual([
      'datasources.cost.request.path',
    ]);
    expect(paths(costReport('/x/${ $string(ds.scope) }'))).toEqual(['datasources.cost.request.path']);
  });

  it('flags tenant data from a Microsoft response, and accepts it encoded', () => {
    const def = (filter: string) => ({
      datasources: {
        other: { source: 'graph', request: { path: '/me' } },
        users: { source: 'graph', request: { path: '/users', query: { $filter: filter } } },
      },
    });
    expect(paths(def("id eq '${ ds.other.id }'"))).toEqual(['datasources.users.request.query.$filter']);
    expect(paths(def("displayName eq '${ ds.other.value[0].displayName }'"))).toHaveLength(1);
    expect(lintExpressions(def('id eq ${ $odata($guid(ds.other.id)) }'))).toEqual([]);
  });

  it('follows params through a static datasource and a transform that keeps them as they came', () => {
    const def = (other: Record<string, unknown>) => ({
      datasources: {
        other: { source: 'static', ...other },
        users: {
          source: 'graph',
          request: { path: '/users', query: { $filter: "id eq '${ ds.other.id }'" } },
        },
      },
    });
    expect(paths(def({ data: { id: '${ params.q }' } }))).toHaveLength(1);
    expect(paths(def({ data: {}, transform: "${ { 'id': $trim(params.q) } }" }))).toHaveLength(1);
    expect(
      paths(def({ data: { id: '${ params.q }' }, transform: "${ { 'id': $guid(value.id) } }" })),
    ).toEqual([]);
    expect(paths(def({ data: { id: 'fixed', kind: '${ params.q }' } }))).toEqual([]);
    expect(paths(def({ data: [{ id: 'a' }, { id: 'b' }] }))).toEqual([]);
  });

  it('follows a datasource built from another one', () => {
    const def = {
      datasources: {
        first: { source: 'graph', request: { path: '/me' } },
        second: {
          source: 'static',
          data: {},
          transform: "${ { 'id': ds.first.id, 'safe': $encode(ds.first.id) } }",
        },
        users: {
          source: 'graph',
          request: { path: '/users/${ ds.second.safe }', query: { $filter: "id eq '${ ds.second.id }'" } },
        },
      },
    };
    expect(paths(def)).toEqual(['datasources.users.request.query.$filter']);
  });

  it('treats a datasource that refers to itself as user data', () => {
    const def = {
      datasources: {
        a: { source: 'static', data: {}, transform: "${ { 'id': ds.a.id } }" },
        users: { source: 'graph', request: { path: '/users', query: { $filter: "id eq '${ ds.a.id }'" } } },
      },
    };
    expect(paths(def)).toHaveLength(1);
  });
});

describe('lint: whole-value paths', () => {
  const page = (type: Record<string, unknown>, path = '${ params.p }') => ({
    params: { p: type },
    datasources: { x: { source: 'arm', request: { path, apiVersion: '2024-01-01' } } },
  });

  it.each([
    [{ type: 'string' }],
    [{ type: 'resource', multiple: true }],
    [{ type: 'string', format: 'upn' }],
  ])('flags a whole path from a %j param', (type) => {
    const issues = lintExpressions(page(type));
    expect(issues.map((i) => i.path)).toEqual(['datasources.x.request.path']);
    expect(issues[0]!.message).toMatch(/guid or an entity id/);
  });

  it.each([
    [{ type: 'resource' }],
    [{ type: 'subscription' }],
    [{ type: 'guid' }],
    [{ type: 'string', format: 'guid' }],
    // One of the declared values (the API refuses any other): a literal allowlist by declaration.
    [{ type: 'enum', values: ['/a', '/b'] }],
  ])('accepts a whole path straight from a %j param', (type) => {
    expect(lintExpressions(page(type))).toEqual([]);
  });

  it('accepts a whole path from an entity input of a playbook', () => {
    expect(
      lintExpressions({
        inputs: { sessionHostId: { type: 'resource' } },
        steps: [{ id: 'get', request: { method: 'GET', path: '${ inputs.sessionHostId }' } }],
      }),
    ).toEqual([]);
  });

  it('still flags an entity id that is changed or placed in a longer path', () => {
    expect(paths(page({ type: 'resource' }, '${ $lowercase(params.p) }'))).toHaveLength(1);
    expect(paths(page({ type: 'resource' }, '${ params.p }/providers/X'))).toHaveLength(1);
    expect(paths(page({ type: 'resource' }, "${ params.p & '/x' }"))).toHaveLength(1);
  });

  it('flags a whole path from row data and a whole url from user data', () => {
    expect(paths({ request: { path: '${ row.id }' } })).toEqual(['request.path']);
    expect(paths({ steps: [{ request: { url: '${ inputs.target }' } }] })).toEqual(['steps[0].request.url']);
  });
});

describe('lint: whole-value KQL queries', () => {
  const rg = (query: string) => ({
    params: { kql: { type: 'string', multiline: true } },
    datasources: { q: { source: 'resourceGraph', query } },
  });

  it('flags a query taken whole from a param', () => {
    const issues = lintExpressions(rg('${ params.kql }'));
    expect(issues.map((i) => i.path)).toEqual(['datasources.q.query']);
    expect(issues[0]!.message).toMatch(/adminforge: user-query/);
  });

  it('accepts it with the explicit opt-in', () => {
    expect(lintExpressions(rg('${ /* adminforge: user-query */ params.kql }'))).toEqual([]);
  });

  it('keeps the opt-in to the whole query: anything built around the param is still flagged', () => {
    expect(paths(rg("${ /* adminforge: user-query */ 'resources | ' & params.kql }"))).toHaveLength(1);
    expect(paths(rg('resources | ${ /* adminforge: user-query */ params.kql }'))).toHaveLength(1);
    expect(paths(rg('${ /* adminforge: user-query */ $lowercase(params.kql) }'))).toHaveLength(1);
  });

  it('accepts a whole query that is not user data', () => {
    expect(lintExpressions(rg("${ 'resources | take ' & $string($number(params.n)) }"))).toEqual([]);
  });
});
