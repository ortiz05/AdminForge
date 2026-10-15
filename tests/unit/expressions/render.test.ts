import { ExpressionError, renderString, renderTemplate } from '@adminforge/expressions';

const scope = {
  params: { n: 2, q: '', userType: 'Guest' },
  row: { id: '00000000-0000-4000-8000-000000000001', accountEnabled: true },
  user: { upn: 'a.lee@example.com' },
};

describe('renderTemplate', () => {
  it('keeps the type of a whole-value expression', async () => {
    expect(await renderString('${ params.n + 1 }', scope)).toBe(3);
    expect(await renderString('${ row.accountEnabled }', scope)).toBe(true);
    expect(await renderString('${ [1, 2] }', scope)).toEqual([1, 2]);
    expect(await renderString('${ { "a": params.n } }', scope)).toEqual({ a: 2 });
    expect(await renderString('${ params.missing }', scope)).toBeUndefined();
  });
  it('interpolates mixed templates to a string', async () => {
    expect(await renderString('/users/${ $encode(row.id) }/memberOf', scope)).toBe(
      '/users/00000000-0000-4000-8000-000000000001/memberOf',
    );
    expect(
      await renderString(
        'n=${ params.n }, on=${ row.accountEnabled }, list=${ [1,2] }, none=${ params.x }',
        scope,
      ),
    ).toBe('n=2, on=true, list=[1,2], none=');
  });
  it('leaves strings without templates alone and unescapes $${', async () => {
    expect(await renderString('plain $ text {}', scope)).toBe('plain $ text {}');
    expect(await renderString('literal $${ not.an.expression }', scope)).toBe(
      'literal ${ not.an.expression }',
    );
  });
  it('handles braces and strings inside expressions', async () =>
    expect(await renderString("${ '{' & params.userType & '}' } and ${ \"}\" }", scope)).toBe(
      '{Guest} and }',
    ));
  it('deep-renders objects and arrays and drops undefined keys', async () => {
    const out = await renderTemplate(
      {
        method: 'GET',
        path: '/users/${ $encode(row.id) }',
        query: {
          $filter: '${ params.userType != "All" ? "userType eq " & $odata(params.userType) }',
          $search: '${ params.q ? params.q }',
          $top: 5,
        },
        body: [{ upn: '${ user.upn }' }, 7, null],
      },
      scope,
    );
    expect(out).toEqual({
      method: 'GET',
      path: '/users/00000000-0000-4000-8000-000000000001',
      query: { $filter: "userType eq 'Guest'", $top: 5 },
      body: [{ upn: 'a.lee@example.com' }, 7, null],
    });
  });
  it('reports where a failing template sits', async () => {
    const err = (await renderTemplate(
      { request: { path: '/users/${ $encode(inputs.missing) }' } },
      { inputs: {} },
    ).catch((e: unknown) => e)) as ExpressionError;
    expect(err).toBeInstanceOf(ExpressionError);
    expect(err.path).toBe('request.path');
    expect(err.message).toMatch(/value is missing — in expression: \$encode\(inputs.missing\)/);
  });
  it('reports malformed templates as ExpressionError', async () => {
    const err = (await renderTemplate(['${ oops'], {}).catch((e: unknown) => e)) as ExpressionError;
    expect(err).toBeInstanceOf(ExpressionError);
    expect(err.path).toBe('[0]');
  });
});
