import { collectExpressions, lintExpressions, validateExpressions } from '@adminforge/expressions';

describe('validateExpressions', () => {
  it('reports empty ${ } and ignores escaped $${', () => {
    expect(validateExpressions({ title: 'Cost $${ x }' })).toEqual([]);
    expect(validateExpressions({ title: 'Oops ${ }' })[0]!.message).toMatch(/Empty/);
  });
  it('passes a clean definition', () =>
    expect(
      validateExpressions({
        steps: [{ request: { path: '/users/${ $encode(inputs.id) }' }, that: '${ a = true }' }],
      }),
    ).toEqual([]));
  it('reports the path of every bad expression', () => {
    const issues = validateExpressions({
      datasources: { users: { request: { query: { $filter: '${ params.a = }' } } } },
      steps: [
        { id: 'ok', when: '${ true }' },
        { id: 'bad', message: 'x ${ "unterminated }' },
      ],
    });
    expect(issues.map((i) => i.path)).toEqual([
      'datasources.users.request.query.$filter',
      'steps[1].message',
    ]);
    expect(issues[0]).toMatchObject({
      expression: 'params.a =',
      segments: ['datasources', 'users', 'request', 'query', '$filter'],
    });
    expect(issues[0]!.message).toMatch(/Invalid expression/);
    expect(issues[1]!.message).toMatch(/Unterminated string literal/);
  });
  it('skips test data by default', () =>
    expect(validateExpressions({ tests: [{ mocks: { a: '${ broken' } }] })).toEqual([]));
  it('collects expression sources', () =>
    expect(collectExpressions({ a: '${ env.AF_X }', b: ['x ${ 1 } ${ 2 }'] })).toEqual([
      { path: 'a', source: 'env.AF_X' },
      { path: 'b[0]', source: '1' },
      { path: 'b[0]', source: '2' },
    ]));
});

describe('lintExpressions', () => {
  it('flags user data concatenated into $filter without $odata', () => {
    const warnings = lintExpressions({ query: { $filter: '${ "displayName eq \'" & params.q & "\'" }' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      path: 'query.$filter',
      message: expect.stringMatching(/without \$odata\(\)/),
    });
  });
  it('accepts $odata / $odataSearch and constant clauses', () =>
    expect(
      lintExpressions({
        query: {
          $filter:
            '${ $join([params.t != "All" ? "userType eq " & $odata(params.t), "accountEnabled eq true"][$], " and ") }',
          $search: "${ params.q ? '\"displayName:' & $odataSearch(params.q) & '\"' }",
        },
      }),
    ).toEqual([]));
  it('flags raw $search concatenation', () =>
    expect(
      lintExpressions({ q: { $search: "${ '\"displayName:' & params.q & '\"' }" } })[0]!.message,
    ).toMatch(/\$odataSearch/));
});
