import { lintExpressions } from '@adminforge/expressions';

// User data placed straight into OData text (not only `&`-concatenated) is flagged like it is for KQL and paths:
// `$filter` / `$search` / `$orderby` anywhere (Graph or ARM query, request body), and `filter` / `search` / `orderBy`
// inside a request body (Intune report exports and `getXxxReport` actions).
const graphQuery = (query: Record<string, string>) => ({
  datasources: { users: { source: 'graph', request: { path: '/users', query } } },
});

const paths = (def: unknown) => lintExpressions(def).map((i) => i.path);
const messages = (def: unknown) => lintExpressions(def).map((i) => i.message);

describe('OData lint: user data interpolated into the text', () => {
  it('flags $filter text with user data in it', () => {
    const def = graphQuery({ $filter: "startswith(displayName,'${ params.q }')" });
    expect(paths(def)).toEqual(['datasources.users.request.query.$filter']);
    expect(messages(def)[0]).toBe(
      'User data is placed in $filter without $odata() (or another quoting helper such as $guid() or $number()).',
    );
  });

  it('flags $search text with user data in it', () => {
    const def = graphQuery({ $search: '"displayName:${ params.q }"' });
    expect(paths(def)).toEqual(['datasources.users.request.query.$search']);
    expect(messages(def)[0]).toMatch(/placed in \$search without \$odataSearch\(\)/);
  });

  it('flags $orderby built from user data, concatenated or interpolated', () => {
    expect(messages(graphQuery({ $orderby: '${ params.sort } desc' }))[0]).toMatch(
      /placed in \$orderby without a literal allowlist/,
    );
    expect(messages(graphQuery({ $orderby: "${ params.sort & ' desc' }" }))[0]).toMatch(
      /concatenated into \$orderby without a literal allowlist/,
    );
  });

  it('flags an ARM $filter', () => {
    const def = {
      datasources: {
        assignments: {
          source: 'arm',
          request: {
            path: '/subscriptions/${ $encode(params.sub) }/providers/Microsoft.Authorization/roleAssignments',
            query: { 'api-version': '2022-04-01', $filter: "principalId eq '${ inputs.principalId }'" },
          },
        },
      },
    };
    expect(paths(def)).toEqual(['datasources.assignments.request.query.$filter']);
  });

  it('flags filters inside a request body', () => {
    const def = {
      steps: [
        {
          id: 'export',
          request: {
            method: 'POST',
            path: '/deviceManagement/reports/exportJobs',
            body: { reportName: 'Devices', filter: "(DeviceName eq '${ inputs.device }')" },
          },
        },
        {
          id: 'report',
          request: {
            method: 'POST',
            path: '/deviceManagement/reports/getDevicesReport',
            body: {
              search: '${ inputs.q }',
              orderBy: ['${ inputs.sort } asc'],
              $filter: "${ 'userId eq ' & inputs.user }",
            },
          },
        },
      ],
    };
    expect(paths(def)).toEqual([
      'steps[0].request.body.filter',
      'steps[1].request.body.search',
      'steps[1].request.body.orderBy[0]',
      'steps[1].request.body.$filter',
    ]);
  });

  it('flags a whole $filter taken from user data (a raw filter param)', () => {
    expect(paths(graphQuery({ $filter: '${ params.filter }' }))).toEqual([
      'datasources.users.request.query.$filter',
    ]);
  });

  it('flags user data a conditional or block can yield', () => {
    expect(paths(graphQuery({ $filter: "displayName eq '${ params.q ? params.q : 'x' }'" }))).toHaveLength(1);
    expect(paths(graphQuery({ $filter: "displayName eq '${ ($x := 1; inputs.name) }'" }))).toHaveLength(1);
    expect(paths(graphQuery({ $filter: "id eq '${ row.id }' and x eq '${ item.x }'" }))).toHaveLength(2);
  });
});

describe('OData lint: safe forms', () => {
  it('accepts quoting helpers, interpolated or concatenated', () => {
    expect(
      lintExpressions(
        graphQuery({
          $filter: 'displayName eq ${ $odata(params.q) } and id eq ${ $odata($guid(params.id)) }',
          $search: '"displayName:${ $odataSearch(params.q) }"',
        }),
      ),
    ).toEqual([]);
    expect(
      lintExpressions(
        graphQuery({
          $filter:
            "${ 'createdDateTime ge ' & $daysAgo($number(params.days)) & ' and appId eq ' & $odata($guid(params.appId)) }",
        }),
      ),
    ).toEqual([]);
  });

  it('accepts literal allowlists (the usual form for $orderby)', () => {
    expect(
      lintExpressions(
        graphQuery({
          $orderby:
            "${ params.sort in ['displayName', 'createdDateTime'] ? params.sort & ' desc' : 'displayName' }",
          $filter: "${ params.t in ['Member', 'Guest'] ? 'userType eq ' & $odata(params.t) }",
        }),
      ),
    ).toEqual([]);
  });

  it('accepts values that are not user data (server-compiled advanced filters, steps, env)', () => {
    expect(
      lintExpressions(
        graphQuery({
          $filter: "${ advanced } and createdDateTime ge ${ $daysAgo(30) } and x eq '${ env.AF_X }'",
        }),
      ),
    ).toEqual([]);
  });

  it('leaves widget settings named filter / search alone (not in a request body)', () => {
    expect(
      lintExpressions({
        widgets: [
          {
            search: true,
            filter: '${ params.q }',
            columns: [{ field: 'displayName', filter: 'facet' }],
          },
        ],
        emptyState: { body: 'No match for ${ params.q }' },
      }),
    ).toEqual([]);
  });

  it('skips test data', () =>
    expect(
      lintExpressions({ tests: [{ inputs: { $filter: "startswith(displayName,'${ params.q }')" } }] }),
    ).toEqual([]));
});
