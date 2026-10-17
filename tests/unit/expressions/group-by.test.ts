import { compile, evaluate } from '@adminforge/expressions';

// The grouping constructor (`rows{ key: value }`) is rewritten into a native group-by for evaluation (group-by.ts).
// JSONata's own evaluates every group's value at once, and the pending evaluations count towards the depth guard:
// a lookup with a few hundred distinct keys failed with "nested or recursing too deeply". The native one must answer
// exactly like JSONata's — keys, appended groups, literal keys on empty input, nested groupings and sorts, variables,
// errors — and scale to enterprise-sized lists.

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

const rows = [
  { id: 'a1', name: 'b', n: 3, dept: 'IT', tags: ['x'] },
  { id: 'a2', name: 'a', n: 1, dept: 'HR' },
  { id: 'a3', name: 'c', n: 3, dept: 'IT', tags: ['y', 'z'] },
  { id: 'a4', name: 'a', n: 2, nested: { k: 'k1' } },
  { id: 'a5', name: 'b', n: 1, dept: 'HR', nested: { k: 'k2' } },
];
const nested = [[{ id: 'x' }, { id: 'y' }], { id: 'x' }];

const SAME: Array<[string, Record<string, unknown>]> = [
  ['rows{ id: name }', { rows }],
  ['rows{ id: true }', { rows }],
  ['rows{ dept: name }', { rows }], // several items per key: a sequence
  ['rows{ dept: $count($) }', { rows }],
  ['rows{ dept: $sum(n) }', { rows }],
  ['rows{ dept: $ }', { rows }],
  ['rows{ dept: { "names": name, "total": $sum(n) } }', { rows }],
  ['rows{ name: [id] }', { rows }],
  ['rows{ id: { "name": name, "k": nested.k, "on": true } }', { rows }], // built natively, one item per key
  ['rows{ dept: { "names": name, "k": nested.k } }', { rows }], // built natively over a sequence
  ['rows{ id: { "a": n, "a": name } }', { rows }], // duplicate keys: JSONata's D1009 path
  ['rows{ nested.k: id }', { rows }],
  ['rows{ $lowercase(dept): id }', { rows }],
  ['rows{ dept: id, name: n }', { rows }], // two pairs
  ['rows[n > 1]{ id: name }', { rows }],
  ['($x := rows; $x{ id: dept })', { rows }],
  ['($k := "id"; rows{ $lookup($, $k): n })', { rows }],
  ['($s := rows{ id: name }; rows[$lookup($s, id) = "a"].id)', { rows }],
  ['rows{ dept: name^($) }', { rows }], // an order-by inside the value
  ['rows{ dept: $map($, function($r) { $r.id }) }', { rows }],
  ['rows{ dept: (tags{ $: true }) }', { rows }], // a grouping inside the value
  ['rows{ "all": $count($) }', { rows }], // a literal key
  ['rows[id = "zz"]{ "all": $count($), "none": id }', { rows }], // empty input still builds literal keys
  ['{ "count": $count(rows) }', { rows }],
  ['nested{ id: true }', { nested }], // arrays in the input flatten
  ['nested{ id: $count($) }', { nested }],
  ['(rows{ dept: $sum(n) }).IT', { rows }],
  ['$keys(rows{ name: id })', { rows }],
];

describe('native group-by answers like JSONata', () => {
  it.each(SAME)('%s', async (expr, scope) => {
    expect(await fast(expr, scope)).toEqual(await original(expr, scope));
  });

  it.each([
    ['rows{ n: id }', { rows }], // T1003: a key must be a string
    ['rows{ id: name, name: id }', { rows: [{ id: 'a', name: 'a' }] }], // D1009: one key from two pairs
    ['rows{ k: 1 }', { rows: [{ k: '_jsonata_lambda' }] }], // D1013
  ])('keeps JSONata errors: %s', async (expr, scope) => {
    const o = await original(expr, scope);
    expect(o.code).toBeTruthy();
    expect(await fast(expr, scope)).toEqual(o);
  });

  it('a key "__proto__" is just a key (no prototype pollution)', async () => {
    const out = (await evaluate('rows{ id: n }', {
      rows: [
        { id: '__proto__', n: 1 },
        { id: 'constructor', n: 2 },
      ],
    })) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).n).toBeUndefined();
  });

  it('never changes the input', async () => {
    const input = [[{ id: 'x', n: 1 }], { id: 'x', n: 2 }];
    const before = JSON.stringify(input);
    await evaluate('input{ id: $sum(n) }', { input });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps the shapes it can’t express natively on JSONata’s grouping (tuple streams, parent)', async () => {
    const scope = { rows };
    for (const expr of ['rows#$i{ id: $i }', 'rows@$r{ $r.id: $r.n }', 'rows.nested{ k: %.id }'])
      expect(await fast(expr, scope)).toEqual(await original(expr, scope));
  });
});

describe('native group-by at enterprise size', () => {
  const big = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      dept: `d${i % 40}`,
      n: i,
      nested: { k: `k${i}` },
    }));

  it.each([2_000, 20_000])('a lookup with %i distinct keys within the 250 ms budget', async (n) => {
    const value = { value: big(n) };
    const out = await evaluate('$count($keys(value.value{ id: { "n": n, "k": nested.k } }))', { value });
    expect(out).toBe(n);
  });

  it('a lookup with 50,000 distinct keys stays linear (a few hundred ms, not seconds)', async () => {
    // At 50k rows this sits near the 250 ms page budget on a loaded machine (real pages at 50k groups do too), so the
    // test allows 2 s and checks it scales: JSONata's own grouping failed outright past ~500 keys.
    const value = { value: big(50_000) };
    const started = performance.now();
    const out = await evaluate(
      '$count($keys(value.value{ id: { "n": n, "k": nested.k } }))',
      { value },
      { timeoutMs: 2_000 },
    );
    expect(out).toBe(50_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('50k rows grouped into 40 keys, each a sequence the value sees', async () => {
    const value = { value: big(50_000) };
    const out = (await evaluate('value.value{ dept: $count($) }', { value })) as Record<string, number>;
    expect(Object.keys(out)).toHaveLength(40);
    expect(out.d0).toBe(1_250);
  });

  it('still stops at the time budget on a heavy value', async () => {
    const value = { value: big(50_000) };
    await expect(
      evaluate('value.value{ id: $string($sum([1..200])) }', { value }, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});
