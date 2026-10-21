import { lintExpressions, validateExpressions } from '@adminforge/expressions';

// S-03 / S-13, second round (the security review's probes): user data reaching a query through functions kept as
// values, the context JSONata hands a built-in, a rebound `$$`, a character allowlist outside quotes, decoders, an
// encoder in the wrong kind of text or taken apart again, playbook step results, a `forEach` name that shadows a
// root, and the person's filter values on a `dialect: rows` page.
const graph = (query: Record<string, string>, path = '/users') => ({
  datasources: { users: { source: 'graph', request: { path, query } } },
});
const rg = (query: string) => ({ datasources: { r: { source: 'resourceGraph', query } } });
const flagged = (def: unknown) => lintExpressions(def).map((i) => i.path);
const FILTER = 'datasources.users.request.query.$filter';

describe('lint: functions kept as values', () => {
  it.each([
    ['a partial application', '$substring(params.q, ?)(0)'],
    ['a partial bound to a variable', '($f := $substring(params.q, ?); $f(0))'],
    ['a partial of $lookup', "$lookup(params, ?)('q')"],
    ['a partial given to $map', "$map(['q'], $lookup(params, ?))[0]"],
    ['a partial applied with ~>', "'q' ~> $lookup(params, ?)"],
    ['a lambda given to a lambda', '(function($g) { $g() })(function() { params.q })'],
    ['a lambda in an array', '[function() { params.q }][0]()'],
    ['a lambda in an object', "{ 'f': function() { params.q } }.f()"],
    ['a lambda returned by a lambda', '(function() { function() { params.q } })()()'],
    ['a lambda chosen by a condition', '($g := true ? function() { params.q } : 0; $g())'],
    ['lambdas mapped over', '$map([function() { params.q }], function($f) { $f() })[0]'],
    ['a stored transform', "($t := | $ | { 'a': $$.params.q } |; $t({}).a)"],
    ['a function rebound in a branch over data', '($v := params.q; false ? $v := $odata : 0; $v)'],
    ['one of two functions a branch may bind', '($f := $string; false ? $f := $odata : 0; $f(params.q))'],
    ['a rebound $$', "($$ := { 'a': params.q }; $$.a)"],
  ])('flags %s', (_, expr) => {
    expect(flagged(graph({ $filter: `id eq '\${ ${expr} }'` }))).toEqual([FILTER]);
  });

  it('keeps an encoder given as a partial application clean', () => {
    expect(
      lintExpressions(graph({ $filter: "${ 'id in (' & $join($map(params.ids, $odata(?)), ',') & ')' }" })),
    ).toEqual([]);
  });
});

describe('lint: the context JSONata hands a built-in', () => {
  it.each([
    ['a computed first argument', 'params.q.$substring((0), 999)'],
    ['a variable first argument', '($n := 0; params.q.$substring($n, 999))'],
    ['a function result as first argument', 'params.q.$substring($count([]), 999)'],
    ['$pad given its width only', "params.q.$pad((1), ' ')"],
    ['$replace given pattern and replacement only', "params.q.$replace(('zz'), 'zz', 1)"],
    ['$sift given a function variable', '($f := function($v) { true }; params.$sift($f).q)'],
    ['$each given only its function', 'params.$each(function($v) { $v })[0]'],
  ])('flags %s', (_, expr) => {
    expect(flagged(graph({ $filter: `id eq '\${ ${expr} }'` }))).toEqual([FILTER]);
  });
});

describe('lint: a character allowlist is safe only inside a quoted literal', () => {
  it.each([
    ['interpolated without quotes', "id eq ${ $replace(params.q, /[^A-Za-z0-9 ]/, '') }"],
    ['concatenated without quotes', "${ 'id eq ' & $replace(params.q, /[^A-Za-z0-9 ]/, '') }"],
    [
      'letters only, without quotes (a property name)',
      "${ 'displayName eq ' & $replace(params.q, /[^A-Za-z]/, '') }",
    ],
    ['opened but not closed', "${ \"id eq '\" & $replace(params.q, /[^A-Za-z0-9 ]/, '') }"],
  ])('flags it %s in $filter', (_, filter) => {
    const issues = lintExpressions(graph({ $filter: filter }));
    expect(issues.map((i) => i.path)).toEqual([FILTER]);
    expect(issues[0]!.message).toMatch(/safe only inside a quoted literal/);
  });

  it('flags it unquoted in KQL', () => {
    expect(flagged(rg("resources | where name == ${ $replace(params.q, /[^A-Za-z0-9 |]/, '') }"))).toEqual([
      'datasources.r.query',
    ]);
  });

  it.each([
    ['between quotes of the text', "id eq '${ $replace(params.q, /[^A-Za-z0-9 ]/, '') }'"],
    [
      'between quotes of the expression',
      '${ "id eq \'" & $replace(params.q, /[^A-Za-z0-9 ]/, \'\') & "\'" }',
    ],
    [
      'inside a literal opened earlier',
      "${ \"a eq 'x' or id eq '\" & $replace(params.q, /[^A-Za-z]/, '') & \"/'\" }",
    ],
    ['digits only, without quotes', "n eq ${ $replace($string(params.n), /[^0-9]/, '') }"],
  ])('accepts it %s', (_, filter) => {
    expect(lintExpressions(graph({ $filter: filter }))).toEqual([]);
  });

  it('accepts it inside a KQL literal that spans several expressions', () => {
    expect(
      lintExpressions(
        rg(
          "resources\n// the site's role assignments\n| where id startswith tolower('/subscriptions/${ $guid(params.sub) }/resourcegroups/${ $replace(params.rg, /[^A-Za-z0-9._()-]/, '') }/')",
        ),
      ),
    ).toEqual([]);
  });

  it('keeps a quoted allowlist with slashes out of a path', () => {
    expect(
      flagged(graph({}, '/sites/${ "\'" & $replace(params.q, /[^A-Za-z0-9.\\/]/, \'\') & "\'" }')),
    ).toEqual(['datasources.users.request.path']);
  });
});

describe('lint: decoders, and encoders where they do not belong', () => {
  it.each([
    [
      '$decodeUrlComponent of allowlisted text',
      "id eq '${ $decodeUrlComponent($replace(params.q, /[^A-Za-z0-9%]/, '')) }'",
    ],
    [
      '$base64decode of allowlisted text',
      "id eq '${ $base64decode($replace(params.q, /[^A-Za-z0-9+=]/, '')) }'",
    ],
    ['$odataSearch in $filter', "displayName eq '${ $odataSearch(params.q) }'"],
    ['$kql in $filter', "displayName eq '${ $kql(params.q) }'"],
    ['$encode in $filter', "displayName eq '${ $encode(params.q) }'"],
    ['an encoded value taken apart again', 'displayName eq ${ $substring($odata(params.q), 1) }'],
    ['escaping undone', 'displayName eq ${ $replace($odata(params.q), "\'\'", "\'") }'],
  ])('flags %s', (_, filter) => {
    expect(flagged(graph({ $filter: filter }))).toEqual([FILTER]);
  });

  it('flags $odata in a path and in KQL, and $encode in KQL', () => {
    expect(flagged(graph({}, '/users/${ $odata(params.q) }/memberOf'))).toEqual([
      'datasources.users.request.path',
    ]);
    expect(flagged(rg("resources | where name == '${ $odata(params.q) }'"))).toEqual(['datasources.r.query']);
    expect(flagged(rg("resources | where name == '${ $encode(params.q) }'"))).toEqual([
      'datasources.r.query',
    ]);
  });

  it('flags $odata in $search, and accepts $odataSearch there', () => {
    expect(flagged(graph({ $search: '"displayName:${ $odata(params.q) }"' }))).toEqual([
      'datasources.users.request.query.$search',
    ]);
    expect(lintExpressions(graph({ $search: '"displayName:${ $odataSearch(params.q) }"' }))).toEqual([]);
  });

  it('keeps $guid clean anywhere and encoded values used as they are', () => {
    expect(
      lintExpressions({
        ...graph({
          $filter: "${ 'id eq ' & $lowercase($odata(params.q)) & ' and x eq ' & $guid(params.id) }",
        }),
        steps: [{ id: 's', request: { path: '/users/${ $guid(inputs.id) }' } }],
      }),
    ).toEqual([]);
  });
});

describe('lint: playbook step results', () => {
  const playbook = (...steps: unknown[]) => ({
    kind: 'playbook',
    inputs: { x: { type: 'string' } },
    steps,
  });

  it('flags a transform step that passes an input on, and a response used as it came', () => {
    expect(
      flagged(
        playbook(
          { id: 'p', type: 'transform', expression: '${ inputs.x }' },
          {
            id: 'del',
            type: 'arm',
            mode: 'write',
            request: { method: 'DELETE', path: '${ steps.p.output }' },
          },
        ),
      ),
    ).toEqual(['steps[1].request.path']);
    expect(
      flagged(
        playbook(
          { id: 'find', type: 'graph', request: { path: '/me' } },
          {
            id: 'g',
            type: 'graph',
            request: {
              path: '/groups',
              query: { $filter: "displayName eq '${ steps.find.output.displayName }'" },
            },
          },
        ),
      ),
    ).toEqual(['steps[1].request.query.$filter']);
  });

  it('accepts a transform step that encodes, wherever the step sits', () => {
    expect(
      lintExpressions({
        kind: 'runbook',
        inputs: { id: { type: 'string' } },
        sections: [
          {
            steps: [
              { id: 'path', type: 'transform', expression: "${ '/users/' & $encode(inputs.id) }" },
              { id: 'get', type: 'graph', request: { path: '${ steps.path.output }/memberOf' } },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe('lint: roots a definition rebinds', () => {
  it('treats a forEach item named like another root as user data', () => {
    expect(
      flagged({
        kind: 'playbook',
        inputs: { ids: { type: 'string' } },
        steps: [
          {
            id: 'l',
            type: 'forEach',
            as: 'ds',
            items: '${ inputs.ids }',
            steps: [
              { id: 'g', type: 'graph', request: { path: '/users', query: { $filter: "id eq '${ ds }'" } } },
            ],
          },
        ],
      }),
    ).toEqual(['steps[0].steps[0].request.query.$filter']);
  });

  it("treats advanced as the person's values on a dialect: rows page, and as compiled text otherwise", () => {
    const page = (dialect: string) => ({
      filters: { advanced: { dialect, param: 'f' } },
      datasources: {
        users: {
          source: 'graph',
          request: { path: '/users', query: { $filter: "id eq '${ advanced.clauses[0].value }'" } },
        },
      },
    });
    expect(flagged(page('rows'))).toEqual([FILTER]);
    expect(flagged(page('odata'))).toEqual([]);
  });
});

describe('lint: quotes the analysis cannot see coming', () => {
  it.each([
    ['a quote put in by $replace', "name eq '${ $replace($replace(params.q, /[^a-z]/, ''), 'q', \"'\") }'"],
    ['a quote padded in', "name eq '${ $pad($replace(params.q, /[^a-z]/, ''), 6, \"'\") }'"],
    ['a quote as the $join separator', "name eq '${ $join([$replace(params.q, /[^a-z]/, '')], \"'\") }'"],
    [
      'quotes cut off again after concatenation',
      'name eq ${ $substringBefore($substringAfter("\'" & $replace(params.q, /[^a-z ]/, \'\') & "\'", "\'"), "\'") }',
    ],
    [
      'a quote held by a variable between the literals',
      "${ ($p := \"'\"; \"name eq '\" & $p & ' x ' & $replace(params.q, /[^a-z ]/, '') & \" y '\") }",
    ],
    [
      'a quote from another expression of the text',
      "name eq '${ \"'\" } ${ $replace(params.q, /[^a-z ]/, '') } x '",
    ],
    [
      'a backslash, which OData does not treat as an escape',
      "name eq 'c:\\' and x eq ${ $replace(params.q, /[^a-z ]/, '') } and y eq ''",
    ],
  ])('flags %s', (_, filter) => {
    expect(flagged(graph({ $filter: filter }))).toEqual([FILTER]);
  });

  it('reads a KQL verbatim string and a KQL escape as KQL does', () => {
    // @'c:\' closes at the quote (no escapes in a verbatim string): the allowlisted text after it is unquoted.
    expect(
      flagged(rg("T | where p == @'c:\\' and n == ${ $replace(params.q, /[^a-z ]/, '') } and m == ''")),
    ).toEqual(['datasources.r.query']);
    // '\'' is one quote inside a literal: the allowlisted text is still quoted.
    expect(lintExpressions(rg("T | where n == 'it\\'s ${ $replace(params.q, /[^a-z ]/, '') }'"))).toEqual([]);
  });
});

describe('lint: an encoder counts only for its own kind of text, wherever the value was made', () => {
  const page = (data: string, use: Record<string, unknown>) => ({
    datasources: {
      s: { source: 'static', data: { v: data } },
      users: { source: 'graph', request: { path: '/users', ...use } },
    },
  });

  it('flags $odata from a datasource in a path, and $encode from one in $filter', () => {
    expect(flagged(page('${ $odata(params.q) }', { path: '/users/${ ds.s.v }' }))).toEqual([
      'datasources.users.request.path',
    ]);
    expect(flagged(page('${ $encode(params.q) }', { query: { $filter: "name eq '${ ds.s.v }'" } }))).toEqual([
      FILTER,
    ]);
  });

  it('accepts each encoder from a datasource where it belongs', () => {
    expect(lintExpressions(page('${ $encode(params.q) }', { path: '/users/${ ds.s.v }' }))).toEqual([]);
    expect(
      lintExpressions(page('${ $odata(params.q) }', { query: { $filter: 'name eq ${ ds.s.v }' } })),
    ).toEqual([]);
  });

  it('flags $odata from a transform step in a path', () => {
    expect(
      flagged({
        kind: 'playbook',
        inputs: { x: { type: 'string' } },
        steps: [
          { id: 'p', type: 'transform', expression: '${ $odata(inputs.x) }' },
          { id: 'g', type: 'graph', request: { path: '/users/${ steps.p.output }' } },
        ],
      }),
    ).toEqual(['steps[1].request.path']);
  });
});

describe('lint: a query string in a url', () => {
  const batch = (url: string) => ({
    datasources: {
      b: {
        source: 'graph',
        request: { method: 'POST', path: '/$batch', body: { requests: [{ id: '1', method: 'GET', url }] } },
      },
    },
  });
  const URL = 'datasources.b.request.body.requests[0].url';

  it('reads what follows $filter= as OData text', () => {
    const issues = lintExpressions(batch("/users?$filter=name eq '${ $encode(params.q) }'"));
    expect(issues.map((i) => i.path)).toEqual([URL]);
    expect(issues[0]!.message).toMatch(/placed in \$filter of the url without \$odata\(\)/);
    expect(lintExpressions(batch('/users?$filter=name eq ${ $odata(params.q) }'))).toEqual([]);
    expect(lintExpressions(batch('/users/${ $encode(params.id) }?$select=id'))).toEqual([]);
  });

  it('takes only $guid, numbers or literal allowlists in a query string built inside the expression', () => {
    expect(flagged(batch("${ '/users?$filter=name eq ' & $odata(params.q) }"))).toEqual([URL]);
    expect(flagged(batch('${ "/users?$filter=name eq \'" & $encode(params.q) & "\'" }'))).toEqual([URL]);
    expect(lintExpressions(batch("${ '/users?$filter=id eq ' & $guid(params.id) }"))).toEqual([]);
  });
});

describe('validate: variables are assigned only where the lint can follow them', () => {
  it.each([
    ["($v := 'x'; $count($v := params.q); $v)"],
    ["($v := 'x'; params.ids[$v := $$.params.q]; $v)"],
    ["($v := 'x'; $odata($v := params.q); $v)"],
  ])('refuses %s', (expr) => {
    expect(validateExpressions({ x: `\${ ${expr} }` }).map((i) => i.message)).toEqual([
      expect.stringMatching(/^Assign variables \(\$x := …\) only as a statement of a block/),
    ]);
  });

  it.each([
    ["($v := 'x'; ($v := params.q) ? 1 : 0; $v)"],
    ['($a := 1; $b := function($x) { $y := $x }; $b(2))'],
    ['$v := params.q'],
  ])('accepts %s (a block statement, a function body, the whole expression)', (expr) => {
    expect(validateExpressions({ x: `\${ ${expr} }` })).toEqual([]);
  });
});
