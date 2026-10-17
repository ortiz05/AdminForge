import { applyAdvanced, evaluate, flagIn, idsWhere } from '@adminforge/expressions';

// Native helpers for the app-registration risk checks at enterprise size: the `…Any` row-filter operators (one pass
// over a field for a list of texts), `$idsWhere` (several filters in one pass) and `$flagIn` (true/false per set).
const rows = [
  { id: 'a', web: { redirectUris: ['https://App.azurewebsites.net/cb', 'HTTP://LOCALHOST:5000/cb'] } },
  { id: 'b', web: { redirectUris: ['http://evil.example.com', 'https://x.github.io'] } },
  { id: 'c', web: { redirectUris: [] } },
  { id: 'd' },
  { id: 'e', web: { redirectUris: 'https://single.example.com/(x)*[::1]' } },
];
const where = (op: string, value: unknown, path = 'web.redirectUris') =>
  applyAdvanced(rows, { join: 'and', clauses: [{ path, type: 'string', op, value }] }).map(
    (r) => (r as { id: string }).id,
  );

describe('containsAny / startsWithAny / notContainsAny / notStartsWithAny', () => {
  it('match any of the texts, ignoring case, in any item of a list', () => {
    expect(where('containsAny', ['.AZUREWEBSITES.NET', '.github.io'])).toEqual(['a', 'b']);
    expect(where('startsWithAny', ['http://'])).toEqual(['a', 'b']);
    expect(where('containsAny', ['localhost'])).toEqual(['a']);
  });

  it('are the same as an or of contains / startsWith clauses', () => {
    const texts = ['.azurewebsites.net', '.github.io', 'localhost', 'nothing'];
    const or = applyAdvanced(rows, {
      join: 'or',
      clauses: texts.map((value) => ({ path: 'web.redirectUris', type: 'string', op: 'contains', value })),
    }).map((r) => (r as { id: string }).id);
    expect(where('containsAny', texts)).toEqual(or);
  });

  it('treat the texts as literals (no pattern characters)', () => {
    expect(where('containsAny', ['(x)*[::1]'])).toEqual(['e']);
    expect(where('containsAny', ['.*'])).toEqual([]);
    expect(where('startsWithAny', ['.'])).toEqual([]);
  });

  it('the negations match rows without the field, like notContains', () => {
    expect(where('notContainsAny', ['localhost'])).toEqual(['b', 'c', 'd', 'e']);
    expect(where('notStartsWithAny', ['http://'])).toEqual(['c', 'd', 'e']);
  });

  it('refuse a field, an empty or non-text list, other types and more than 256 texts', () => {
    const bad = (clause: Record<string, unknown>) => () =>
      applyAdvanced(rows, {
        join: 'and',
        clauses: [{ path: 'id', type: 'string', op: 'containsAny', ...clause }],
      });
    expect(bad({ value: [] })).toThrow(/non-empty list of texts/);
    expect(bad({ value: ['a', 1] })).toThrow(/non-empty list of texts/);
    expect(bad({ value: 'a' })).toThrow(/non-empty list of texts/);
    expect(bad({ value: ['a'], type: 'number' })).toThrow(/needs type string/);
    expect(bad({ value: ['a'], field: 'web' })).toThrow(/not a field/);
    expect(bad({ value: Array.from({ length: 257 }, (_, i) => `t${i}`) })).toThrow(/at most 256/);
  });

  it('refuse texts over 256 characters without echoing them', () => {
    const long = `${'secret-'.repeat(37)}x`; // 260 characters
    let message = '';
    try {
      applyAdvanced(rows, {
        join: 'and',
        clauses: [{ path: 'id', type: 'string', op: 'containsAny', value: [long] }],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/at most 256 characters/);
    expect(message).not.toContain('secret');
    expect(message.length).toBeLessThan(200);
    // 256 texts of 256 characters (the most a filter can hold) compile and run.
    const most = Array.from({ length: 256 }, (_, i) => `${i}-`.padEnd(256, '*'));
    expect(where('containsAny', most)).toEqual([]);
  });
});

describe('row filters: size and budget', () => {
  const cond = { path: 'id', type: 'string', op: 'eq', value: 'zzz' };
  const many = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}` }));

  it('refuse more than 64 conditions, nested groups included', () => {
    const flat = { join: 'or', clauses: Array.from({ length: 65 }, () => cond) };
    expect(() => applyAdvanced(rows, flat)).toThrow(/at most 64 conditions/);
    const nested = {
      join: 'or',
      clauses: [cond, { join: 'and', clauses: Array.from({ length: 64 }, () => cond) }],
    };
    expect(() => applyAdvanced(rows, nested)).toThrow(/at most 64 conditions/);
    expect(applyAdvanced(rows, { join: 'or', clauses: Array.from({ length: 64 }, () => cond) })).toEqual([]);
  });

  it('$applyAdvanced stops at the deadline, counting rows × conditions', () => {
    expect(() => applyAdvanced(many, { join: 'and', clauses: [cond] }, Date.now() - 1)).toThrow();
    // 64 conditions × 100 rows is 6,400 units: checked during the rows, not only every 4,096 rows.
    let calls = 0;
    const budget = () => {
      calls++;
    };
    applyAdvanced(
      many.slice(0, 100),
      { join: 'or', clauses: Array.from({ length: 64 }, () => cond) },
      budget,
    );
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('$applyAdvanced in an expression runs on the evaluation budget', async () => {
    const clauses = Array.from({ length: 64 }, (_, i) => ({
      path: 'x',
      type: 'string',
      op: 'containsAny',
      value: Array.from({ length: 256 }, (_, j) => `zz${i}-${j}abcdefgh`),
    }));
    const big = Array.from({ length: 50_000 }, (_, i) => ({ id: `r${i}`, x: 'abcdefgh'.repeat(25) }));
    const started = performance.now();
    await expect(
      evaluate('$count($applyAdvanced(rows, f))', { rows: big, f: { join: 'or', clauses } }),
    ).rejects.toThrow(/timed out/);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('$idsWhere', () => {
  it('returns the ids each filter matches, in one pass', () => {
    const out = idsWhere(rows, 'id', {
      hosting: {
        join: 'or',
        clauses: [{ path: 'web.redirectUris', type: 'string', op: 'containsAny', value: ['.github.io'] }],
      },
      http: {
        join: 'or',
        clauses: [{ path: 'web.redirectUris', type: 'string', op: 'startsWithAny', value: ['http://'] }],
      },
      none: { join: 'and', clauses: [{ path: 'id', type: 'string', op: 'eq', value: 'zzz' }] },
    });
    expect(out).toEqual({ hosting: ['b'], http: ['a', 'b'], none: [] });
  });

  it('takes only texts, numbers and true/false as ids: never lists, objects or functions', async () => {
    const all = { join: 'and', clauses: [{ path: 'name', type: 'string', op: 'notEmpty', value: null }] };
    const out = idsWhere(
      [
        { id: ['x'], name: 'n' },
        { name: 'n' },
        { id: { a: 1 }, name: 'n' },
        { id: () => 1, name: 'n' },
        { id: 7, name: 'n' },
        { id: true, name: 'n' },
      ],
      'id',
      { all },
    );
    expect(out).toEqual({ all: [7, true] });
    // A JSONata lambda at the path is skipped too (it would otherwise leave by reference).
    expect(
      await evaluate(
        '$idsWhere([{ "id": function($x) { $x }, "name": "n" }, { "id": "a", "name": "n" }], "id", { "all": f }).all',
        {
          f: all,
        },
      ),
    ).toEqual(['a']);
  });

  it('names the filter that is wrong', () => {
    expect(() => idsWhere(rows, 'id', { wildcardUri: { nope: true } })).toThrow(
      /\$idsWhere: filter "wildcardUri": not a query-builder filter/,
    );
  });

  it('compiles a filter shared by several names once, with the same ids for each', async () => {
    const out = await evaluate(
      '( $f := { "join": "and", "clauses": [{ "path": "id", "type": "string", "op": "ne", "value": "a" }] }; $idsWhere(rows, "id", { "x": $f, "y": $f }) )',
      { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    );
    expect(out).toEqual({ x: ['b', 'c'], y: ['b', 'c'] });
  });

  it('stops at the deadline: while compiling and by rows × conditions', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}` }));
    const f = { join: 'and', clauses: [{ path: 'id', type: 'string', op: 'eq', value: 'zzz' }] };
    expect(() => idsWhere(many, 'id', { f }, Date.now() - 1)).toThrow();
    // A long `in` list is checked while it is made comparable.
    let calls = 0;
    const budget = () => {
      if (++calls > 1) throw new Error('budget spent');
    };
    const ids = Array.from({ length: 10_000 }, (_, i) => `id${i}`);
    expect(() =>
      idsWhere(
        [],
        'id',
        { f: { join: 'and', clauses: [{ path: 'id', type: 'string', op: 'in', value: ids }] } },
        budget,
      ),
    ).toThrow('budget spent');
    // 64 filters × 100 rows: checked during the rows.
    calls = 0;
    const counting = () => {
      calls++;
    };
    const filters = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `f${i}`,
        { join: 'and', clauses: [{ path: 'id', type: 'string', op: 'eq', value: `v${i}` }] },
      ]),
    );
    idsWhere(many.slice(0, 100), 'id', filters, counting);
    expect(calls).toBeGreaterThan(64);
  });

  it('refuses bad names, too many filters and non-filters', () => {
    const f = { join: 'and', clauses: [{ path: 'id', type: 'string', op: 'notEmpty', value: null }] };
    expect(() => idsWhere(rows, 'id', { ['__proto__']: f } as never)).toThrow(/plain field name/);
    expect(() => idsWhere(rows, 'id', JSON.parse('{"__proto__": {"join":"and","clauses":[]}}'))).toThrow(
      /plain field name/,
    );
    expect(() => idsWhere(rows, 'id', { constructor: f })).toThrow(/plain field name/);
    expect(() =>
      idsWhere(rows, 'id', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, f]))),
    ).toThrow(/at most 64/);
    expect(() => idsWhere(rows, 'id', { x: { nope: true } })).toThrow(/not a query-builder filter/);
    expect(() => idsWhere(rows, '__proto__.x', { x: f })).toThrow();
  });
});

describe('$flagIn', () => {
  const sets = { hosting: ['b'], http: ['a', 'b'], numeric: [7] };

  it('copies each row once with true/false per set, as text', () => {
    const out = flagIn([{ id: 'a', n: 1 }, { id: 'b' }, { id: 7 }, { id: 'z' }], 'id', sets);
    expect(out).toEqual([
      { id: 'a', n: 1, hosting: false, http: true, numeric: false },
      { id: 'b', hosting: true, http: true, numeric: false },
      { id: 7, hosting: false, http: false, numeric: true },
      { id: 'z', hosting: false, http: false, numeric: false },
    ]);
  });

  it('a list at the path matches when any of its values is in the set; the input is not changed', () => {
    const input = [{ ids: ['x', 'b'] }];
    expect(flagIn(input, 'ids', sets)).toEqual([
      { ids: ['x', 'b'], hosting: true, http: true, numeric: false },
    ]);
    expect(input).toEqual([{ ids: ['x', 'b'] }]);
  });

  it('leaves non-object rows as they are and refuses unsafe names and values', () => {
    expect(flagIn(['text', 3], 'id', sets)).toEqual(['text', 3]);
    expect(() => flagIn(rows, 'id', JSON.parse('{"__proto__": ["a"]}'))).toThrow(/plain field name/);
    expect(() => flagIn(rows, 'id', { prototype: ['a'] })).toThrow(/plain field name/);
    expect(() => flagIn(rows, 'id', { _jsonata_x: ['a'] })).toThrow(/plain field name/);
    expect(() => flagIn(rows, 'id', { x: [{ o: 1 }] })).toThrow(/list of texts/);
    expect(() => flagIn(rows, 'id', 'nope')).toThrow(/object of lists/);
  });

  it('only texts, numbers and true/false match: an object or a function at the path never does', () => {
    const out = flagIn([{ id: { a: 1 } }, { id: () => 1 }, { id: [{ a: 1 }, 'b'] }, { id: true }], 'id', {
      s: ['[object Object]', '() => 1', 'b', 'true'],
    });
    expect(out.map((r) => (r as { s: boolean }).s)).toEqual([false, false, true, true]);
  });

  it('caps the values across all sets and builds a list shared by several names once', () => {
    const half = Array.from({ length: 500_001 }, (_, i) => i);
    expect(() => flagIn([{ id: 1 }], 'id', { a: half, b: [...half] })).toThrow(
      /at most 1000000 values across the sets/,
    );
    expect(flagIn([{ id: 1 }], 'id', { a: half, b: half })).toEqual([{ id: 1, a: true, b: true }]);
  });

  it('stops at the deadline while building the sets and while copying the rows', () => {
    let calls = 0;
    const budget = () => {
      if (++calls > 1) throw new Error('budget spent');
    };
    expect(() => flagIn([], 'id', { a: Array.from({ length: 10_000 }, (_, i) => i) }, budget)).toThrow(
      'budget spent',
    );
    const many = Array.from({ length: 10_000 }, (_, i) => ({ id: i }));
    expect(() => flagIn(many, 'id', { a: [1] }, Date.now() - 1)).toThrow();
  });

  it('a JSONata function row passes through uncopied (never a forged function)', async () => {
    // The result copy strips functions; what matters is that no flag field was ever added to one.
    const out = await evaluate('$flagIn([function($x){ $x }], "id", { "a": ["1"] })', {});
    expect(JSON.stringify(out ?? null)).not.toContain('"a"');
  });

  it('is registered with the other helpers and works from an expression', async () => {
    expect(
      await evaluate('$flagIn(rows, "id", { "flag": ["b"] }).flag', { rows: [{ id: 'a' }, { id: 'b' }] }),
    ).toEqual([false, true]);
    expect(
      await evaluate(
        '$idsWhere(rows, "id", { "b": { "join": "and", "clauses": [{ "path": "id", "type": "string", "op": "eq", "value": "b" }] } }).b',
        { rows: [{ id: 'a' }, { id: 'b' }] },
      ),
    ).toEqual(['b']);
  });
});
