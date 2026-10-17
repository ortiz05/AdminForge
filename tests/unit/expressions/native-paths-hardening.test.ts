import {
  applyAdvanced,
  compile,
  evaluate,
  lintExpressions,
  validateExpressions,
  withFields,
} from '@adminforge/expressions';

// Security review of the native fast paths (group-by.ts, order-by.ts) and row helpers (helpers.ts), 2026-10-17:
// one budget for the whole evaluation, JSONata's own-property reads, unwrapped one-item sequences left to JSONata,
// reserved internal names, scope reached through paths and blocks, and the helpers' input checks.

/** JSONata's own answer: the expression as written, without the rewrite. */
async function original(expr: string, scope: Record<string, unknown>) {
  try {
    return {
      value: JSON.parse(JSON.stringify((await compile(expr, { timeoutMs: 60_000 }).evaluate(scope)) ?? null)),
    };
  } catch (err) {
    return { code: (err as { code?: string }).code };
  }
}
async function fast(expr: string, scope: Record<string, unknown>) {
  try {
    return {
      value: JSON.parse(JSON.stringify((await evaluate(expr, scope, { timeoutMs: 60_000 })) ?? null)),
    };
  } catch (err) {
    return { code: (err as { code?: string }).code };
  }
}

describe('group-by shares the one budget', () => {
  const rows = Array.from({ length: 4000 }, (_, i) => ({ id: `k${i}`, m: i % 50 }));

  it('a key evaluated per row stops near the budget, not after a fresh 250 ms per row', async () => {
    const started = performance.now();
    await expect(
      evaluate(
        '($all := rows; rows{ $string($count($all[m = $$.x])) & id: true })',
        { rows },
        { timeoutMs: 250 },
      ),
    ).rejects.toMatchObject({ code: 'D1012' });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('a value evaluated per group stops near the budget too', async () => {
    const started = performance.now();
    await expect(
      evaluate('($all := rows; rows{ id: $count($all[m = 1]) })', { rows }, { timeoutMs: 250 }),
    ).rejects.toMatchObject({ code: 'D1012' });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('native reads see own properties only, as JSONata does', () => {
  const rows = [
    { id: 'g1', name: 'Alpha' },
    { id: 'g2', name: 'Beta' },
  ];
  it.each([
    ['$exists((rows{ id: toString }).g1)'],
    ['rows{ id: { "x": constructor } }'],
    ['rows{ id: { "x": name, "y": hasOwnProperty } }'],
    ['rows^(toString).id'],
  ])('%s', async (expr) => {
    expect(await fast(expr, { rows })).toEqual(await original(expr, { rows }));
  });

  it('a key named after an inherited property is just missing, never the host function', async () => {
    const out = await fast('rows{ toString: id }', { rows });
    expect(out).toEqual(await original('rows{ toString: id }', { rows }));
  });
});

describe('a grouping over a function result keeps JSONata’s grouping', () => {
  it('one row of pairs from $map (a one-item sequence holding an array)', async () => {
    const expr = '$map(rows, function($r) { [$r.id, $r.name] }){ $[0]: $[1] }';
    for (const rows of [
      [{ id: 'g1', name: 'Alpha' }],
      [
        { id: 'g1', name: 'Alpha' },
        { id: 'g2', name: 'Beta' },
      ],
    ])
      expect(await fast(expr, { rows })).toEqual(await original(expr, { rows }));
  });
});

describe('native slice refuses what JSONata refuses', () => {
  it('a range over 1e7 items (D2014)', async () => {
    const rows = [{ n: 2 }, { n: 1 }];
    const expr = 'rows^(n)[[0..100000000]]';
    const o = await original(expr, { rows });
    expect(o.code).toBe('D2014');
    expect(await fast(expr, { rows })).toEqual(o);
  });
});

describe('reserved names and the scope in queries', () => {
  it('$__af* variables are refused', () => {
    const issues = validateExpressions({ text: '${ $__afDeadline }' });
    expect(issues.map((i) => i.message)).toContain(
      'Variables starting with $__af are reserved for AdminForge itself.',
    );
    expect(validateExpressions({ text: '${ $after }' })).toEqual([]);
  });

  const flagged = (filter: string) =>
    lintExpressions({
      datasources: { users: { source: 'graph', request: { path: '/users', query: { $filter: filter } } } },
    }).map((i) => i.path);
  it.each([
    ['startswith(displayName,\'${ $lookup($$, "params").q }\')'],
    ["startswith(displayName,'${ ($).params.q }')"],
    ['startswith(displayName,\'${ $sift($, function($v, $k) { $k = "params" }).params.q }\')'],
    ["startswith(displayName,'${ ($p := $; $p.params.q) }')"],
  ])('flags %s in $filter', (filter) => {
    expect(flagged(filter)).toEqual(['datasources.users.request.query.$filter']);
  });
});

describe('row helpers check their input', () => {
  it('$withFields refuses functions and JSONata’s internal names', async () => {
    expect(() => withFields([{}], { _jsonata_lambda: true })).toThrow(/can't be a field name/);
    expect(() => withFields([{}], { f: () => 1 })).toThrow(/can't be a function/);
    await expect(
      evaluate('$withFields(rows, { "f": function($x) { $x } })', { rows: [{ a: 1 }] }),
    ).rejects.toThrow();
  });

  it('times needs a field and a finite number', () => {
    const rows = [{ a: 1, b: 2 }];
    expect(() =>
      applyAdvanced(rows, {
        join: 'and',
        clauses: [{ path: 'a', type: 'number', op: 'lt', value: 2, times: 2 }],
      }),
    ).toThrow(/times needs a field/);
    expect(() =>
      applyAdvanced(rows, {
        join: 'and',
        clauses: [{ path: 'a', type: 'number', op: 'lt', field: 'b', times: Infinity }],
      }),
    ).toThrow(/times needs a field/);
    expect(
      applyAdvanced(rows, {
        join: 'and',
        clauses: [{ path: 'a', type: 'number', op: 'lt', field: 'b', times: 1 }],
      }),
    ).toEqual(rows);
  });

  it('negated operators match rows without the field (documented)', () => {
    const rows = [{ id: 'a', p: 'x' }, { id: 'b' }];
    const ids = (op: 'ne' | 'notContains' | 'notIn') =>
      (
        applyAdvanced(rows, {
          join: 'and',
          clauses: [{ path: 'p', type: 'string', op, value: op === 'notIn' ? ['x'] : 'x' }],
        }) as Array<{ id: string }>
      ).map((r) => r.id);
    expect(ids('ne')).toEqual(['b']);
    expect(ids('notContains')).toEqual(['b']);
    expect(ids('notIn')).toEqual(['b']);
  });
});
