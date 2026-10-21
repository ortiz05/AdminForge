import { lintExpressions } from '@adminforge/expressions';

// S-03 / S-13, third round: where an encoded value sits matters. `$odata()` and `$kql()` bring their own quotes, so
// they belong outside a quoted literal; `$odataSearch()` only escapes, so it belongs inside the clause's `"…"`. A body
// written as one `${ { … } }` gets the same rules as one written out, `filter` without the `$` in a query map is OData
// too, and inside a quoted literal of a path (`(period='${ … }')`) only letters, digits, `-` and `_` stay inside.
const graph = (query: Record<string, string>, path = '/users') => ({
  datasources: { users: { source: 'graph', request: { path, query } } },
});
const rg = (query: string) => ({ datasources: { r: { source: 'resourceGraph', query } } });
const flagged = (def: unknown) => lintExpressions(def).map((i) => i.path);
const FILTER = 'datasources.users.request.query.$filter';

describe('lint: an encoder that brings its own quotes, inside quotes', () => {
  it.each([
    ['interpolated in a quoted literal', "displayName eq '${ $odata(params.q) }'"],
    ['in a function call’s quoted argument', "startswith(displayName,'${ $odata(params.q) }')"],
    ['concatenated between quotes', '${ "displayName eq \'" & $odata(params.q) & "\'" }'],
  ])('flags $odata %s', (_, filter) => {
    const issues = lintExpressions(graph({ $filter: filter }));
    expect(issues.map((i) => i.path)).toEqual([FILTER]);
    expect(issues[0]!.message).toMatch(/bring their own quotes/);
  });

  it('flags $kql inside a quoted KQL literal, single or double', () => {
    expect(flagged(rg('Resources | where name == "${ $kql(params.q) }"'))).toEqual(['datasources.r.query']);
    expect(flagged(rg("Resources | where name == '${ $kql(params.q) }'"))).toEqual(['datasources.r.query']);
  });

  it('accepts encoders outside quotes, as shipped content writes them', () => {
    expect(
      lintExpressions(
        graph({
          $filter:
            "startswith(displayName,${ $odata(params.q) }) and ${ params.t in ['a', 'b'] ? 'userType eq ' & $odata(params.t) : 'true' }",
        }),
      ),
    ).toEqual([]);
    expect(
      lintExpressions(
        rg(
          "Resources\n| where type =~ 'x'\n${ params.sub ? \"| where subscriptionId == '\" & $guid(params.sub) & \"'\" }\n${ params.q ? '| where name contains ' & $kql(params.q) : '' }",
        ),
      ),
    ).toEqual([]);
  });
});

describe('lint: $odataSearch belongs inside the clause’s quotes', () => {
  it('flags it outside quotes', () => {
    expect(flagged(graph({ $search: "${ 'displayName:' & $odataSearch(params.q) }" }))).toEqual([
      'datasources.users.request.query.$search',
    ]);
  });

  it('accepts it inside quotes, of the text or of the expression', () => {
    expect(lintExpressions(graph({ $search: '"displayName:${ $odataSearch(params.q) }"' }))).toEqual([]);
    expect(
      lintExpressions(
        graph({ $search: "${ params.q ? '\"displayName:' & $odataSearch(params.q) & '\"' : '' }" }),
      ),
    ).toEqual([]);
  });
});

describe('lint: a request body written as one expression', () => {
  const step = (path: string, body: string) => ({
    kind: 'playbook',
    inputs: { q: { type: 'string' } },
    steps: [{ id: 's', type: 'graph', request: { method: 'POST', path, body } }],
  });

  it.each([
    [
      'a hunting Query',
      '/security/runHuntingQuery',
      '${ { \'Query\': "DeviceInfo | where DeviceName == \'" & inputs.q & "\'" } }',
      /body's Query without \$kql\(\)/,
    ],
    [
      'a $batch request url',
      '/$batch',
      "${ { 'requests': [{ 'id': '1', 'method': 'GET', 'url': \"/users?$filter=startswith(displayName,'\" & inputs.q & \"')\" }] } }",
      /\$batch request's url/,
    ],
    [
      'an Intune report filter',
      '/deviceManagement/reports/getDevicesReport',
      "${ { 'filter': \"(DeviceName eq '\" & inputs.q & \"')\", 'top': 50 } }",
      /body's filter without \$odata\(\)/,
    ],
  ])('flags %s', (_, path, body, message) => {
    const issues = lintExpressions(step(path, body));
    expect(issues.map((i) => i.path)).toEqual(['steps[0].request.body']);
    expect(issues[0]!.message).toMatch(message);
  });

  it('accepts encoded fields, bodies without query fields, and opaque bodies sent elsewhere', () => {
    expect(
      lintExpressions(
        step(
          '/security/runHuntingQuery',
          "${ { 'Query': 'DeviceInfo | where DeviceName == ' & $kql(inputs.q) } }",
        ),
      ),
    ).toEqual([]);
    expect(
      lintExpressions(
        step('/sessions/x/sendMessage', "${ { 'messageTitle': inputs.q, 'messageBody': inputs.q } }"),
      ),
    ).toEqual([]);
    expect(lintExpressions(step('/security/incidents/1', '${ inputs.q }'))).toEqual([]);
    expect(flagged(step('/security/runHuntingQuery', '${ inputs.q }'))).toEqual(['steps[0].request.body']);
  });
});

describe('lint: OData options spelled without the $ in a query map', () => {
  it.each([['filter'], ['Filter'], ['orderby'], ['expand']])('lints %s', (key) => {
    expect(flagged(graph({ [key]: "startswith(displayName,'${ params.q }')" }))).toEqual([
      `datasources.users.request.query.${key}`,
    ]);
  });

  it('leaves search alone (a keyword parameter of its own on some endpoints, e.g. sites)', () => {
    expect(lintExpressions(graph({ search: "${ params.q ? params.q : '*' }" }, '/sites'))).toEqual([]);
  });
});

describe('lint: inside a quoted literal of a path', () => {
  const report = (expr: string, period: Record<string, unknown> = { type: 'string' }) => ({
    params: { period },
    datasources: {
      r: {
        source: 'graph',
        request: { path: `/reports/getEmailActivityUserDetail(period='\${ ${expr} }')` },
      },
    },
  });

  it('flags $encode there ($encode leaves quotes alone)', () => {
    const issues = lintExpressions(report('$encode(params.period)'));
    expect(issues.map((i) => i.path)).toEqual(['datasources.r.request.path']);
    expect(issues[0]!.message).toMatch(/only letters, digits, - and _ stay inside it/);
  });

  it('accepts a literal allowlist, a word allowlist, or an enum param (one of its declared values)', () => {
    expect(lintExpressions(report("params.period in ['D7', 'D30'] ? params.period : 'D7'"))).toEqual([]);
    expect(lintExpressions(report("$replace(params.period, /[^A-Za-z0-9]/, '')"))).toEqual([]);
    expect(
      lintExpressions(report('$encode(params.period)', { type: 'enum', values: ['D7', 'D30', 'D90'] })),
    ).toEqual([]);
  });
});
