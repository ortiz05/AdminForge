import { lintExpressions } from '@adminforge/expressions';

// S-03: the publish-time injection lint follows user data (params, inputs, rows, …) the way it follows the scope:
// through every function that is not an encoder, through lambdas and `$map`, through block variables — and into
// `$expand`. The validator's seven probe cases passed the lint before; each is flagged now. The encoders, functions
// whose result is a number, a boolean or a date, literal allowlists and character allowlists keep their forms clean.
const graph = (query: Record<string, string>, path = '/users') => ({
  datasources: { users: { source: 'graph', request: { path, query } } },
});
const flagged = (def: unknown) => lintExpressions(def).map((i) => i.path);
const FILTER = 'datasources.users.request.query.$filter';

describe('lint: user data wrapped in a function, a lambda or a variable (the seven probe cases)', () => {
  it.each([
    ['$lowercase', "startswith(displayName,'${ $lowercase(params.q) }')"],
    ['$string', "displayName eq '${ $string(params.q) }'"],
    ['$join', "displayName eq '${ $join([params.q]) }'"],
    ['a block alias', "displayName eq '${ ($q := params.q; $q) }'"],
    ['$map', "id eq '${ $map(params.ids, function($v) { $v })[0] }'"],
  ])('flags user data through %s in $filter', (_, filter) => {
    expect(flagged(graph({ $filter: filter }))).toEqual([FILTER]);
  });

  it('lints $expand like $filter', () => {
    const def = graph({ $expand: "members($filter=startswith(displayName,'${ params.q }'))" });
    const issues = lintExpressions(def);
    expect(issues.map((i) => i.path)).toEqual(['datasources.users.request.query.$expand']);
    expect(issues[0]!.message).toMatch(/placed in \$expand without \$odata\(\)/);
  });

  it('flags $trim of an id in a request path', () => {
    const issues = lintExpressions(graph({}, '/users/${ $trim(params.id) }'));
    expect(issues.map((i) => i.path)).toEqual(['datasources.users.request.path']);
    expect(issues[0]!.message).toMatch(/placed in the path without \$encode\(\)/);
  });
});

describe('lint: more ways user data reaches a query', () => {
  it.each([
    ['a function applied with ~>', "displayName eq '${ params.q ~> $lowercase }'"],
    ['a path step function (context argument)', "displayName eq '${ params.q.$substring(0, 5) }'"],
    [
      'a lambda bound to a variable',
      "displayName eq '${ ($f := function($x) { $uppercase($x) }; $f(params.q)) }'",
    ],
    ['a lambda called by $reduce', "${ 'x eq ' & $reduce(params.ids, function($a, $v) { $a & $v }, '') }"],
    ['$filter of user data', "id eq '${ $filter(params.ids, function($v) { $v != '' })[0] }'"],
    ['an object constructor', "id eq '${ { 'id': inputs.id }.id }'"],
    ['an array of user data', "${ 'id in (' & $join([inputs.ids], ',') & ')' }"],
    ['a forEach item named with as', "id eq '${ memberId }'"],
    ['a conditional in a variable', "id eq '${ ($v := params.a ? params.a : 'x'; $v) }'"],
    ['$lookup with the scope as context', "id eq '${ $lookup('params').q }'"],
    // \x27 is ' (a quote in the pattern itself would end the template's string).
    ['$replace that keeps quotes', "id eq '${ $replace(params.q, /[^A-Za-z\\x27]/, '') }'"],
    ['$replace with a group reference', "id eq '${ $replace(params.q, /[^A-Za-z]/, '$0') }'"],
    ['$replace limited to some matches', "id eq '${ $replace(params.q, /[^A-Za-z]/, '', 1) }'"],
  ])('flags %s', (_, filter) => {
    const def = {
      ...graph({ $filter: filter }),
      steps: [{ type: 'forEach', as: 'memberId', items: '${ inputs.ids }' }],
    };
    expect(flagged(def)).toEqual([FILTER]);
  });

  it('names concatenation in the message when the data is concatenated', () => {
    expect(lintExpressions(graph({ $filter: "${ 'id eq ' & $trim(params.q) }" }))[0]!.message).toMatch(
      /concatenated into \$filter/,
    );
    expect(lintExpressions(graph({ $filter: "id eq '${ $trim(params.q) }'" }))[0]!.message).toMatch(
      /placed in \$filter/,
    );
  });

  it('flags KQL built from wrapped user data', () => {
    const def = {
      datasources: {
        r: { source: 'resourceGraph', query: "resources | where name =~ '${ $lowercase(params.q) }'" },
      },
    };
    expect(lintExpressions(def)[0]!.message).toMatch(/without \$kql\(\)/);
  });
});

describe('lint: forms that stay clean', () => {
  it.each([
    [
      'the encoders',
      'displayName eq ${ $odata($lowercase(params.q)) } and id eq ${ $odata($guid(params.id)) }',
    ],
    ['an encoder applied with ~>', 'displayName eq ${ params.q ~> $odata }'],
    [
      'encoders inside a lambda',
      "${ 'id in (' & $join($map(params.ids, function($v) { $odata($guid($v)) }), ',') & ')' }",
    ],
    ['an encoder as the $map function', "${ 'id in (' & $join($map(params.ids, $odata), ',') & ')' }"],
    ['an encoded path step', "${ 'id in (' & $join([inputs.ids].$odata($guid($)), ', ') & ')' }"],
    [
      'numbers, booleans and dates',
      "${ 'n eq ' & $string($number(params.n)) & ' and d ge ' & $daysAgo($number(params.days)) & ' and c eq ' & $count(params.ids) }",
    ],
    ['a literal allowlist', "${ params.t in ['Member', 'Guest'] ? 'userType eq ' & $odata(params.t) : '' }"],
    ['a variable holding encoded data', "${ ($q := $odata(params.q); 'displayName eq ' & $q) }"],
    [
      'a variable rebound to the encoded value',
      "${ ($q := params.q; $q := $odata($q); 'displayName eq ' & $q) }",
    ],
    [
      'a character allowlist without quotes',
      "displayName eq '${ $replace(params.q, /[^A-Za-z0-9 ._()-]/, '') }'",
    ],
    [
      'a lambda bound to a variable that encodes',
      "${ ($f := function($x) { $odata($x) }; 'displayName eq ' & $f(params.q)) }",
    ],
    ['user data used only in a condition', "${ $contains(params.q, 'x') ? 'a eq 1' : 'a eq 2' }"],
    ['the server-compiled advanced filter', "${ advanced } and x eq '${ env.AF_X }'"],
  ])('accepts %s', (_, filter) => {
    expect(lintExpressions(graph({ $filter: filter }))).toEqual([]);
  });

  it('accepts the shipped $expand ternaries', () => {
    expect(
      lintExpressions(
        graph({
          $expand:
            "${ params.owners in ['Owned', 'Ownerless'] ? undefined : 'owners($select=id,displayName,userPrincipalName)' }",
        }),
      ),
    ).toEqual([]);
  });

  it('accepts path segments encoded one by one', () => {
    expect(
      lintExpressions(
        graph({}, "${ $join($split(params.id, '/')[$ != ''].('/' & $encode($)), '') }/providers/X"),
      ),
    ).toEqual([]);
  });

  it('keeps a character allowlist with dots or slashes out of a path', () => {
    expect(flagged(graph({}, "/sites/${ $replace(params.q, /[^A-Za-z0-9._()-]/, '') }"))).toEqual([
      'datasources.users.request.path',
    ]);
    expect(lintExpressions(graph({}, "/sites/${ $replace(params.q, /[^A-Za-z0-9-]/, '') }"))).toEqual([]);
  });
});
