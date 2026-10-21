import {
  evaluate,
  lintExpressions,
  MAX_PAD,
  MAX_SEQUENCE,
  validateExpressions,
} from '@adminforge/expressions';

// One JSONata built-in call runs to completion between timeout checks: these must stay bounded (they ran 2–8 s, and
// `$sort` on a big range exhausted the heap). `$eval` would run code taken from data.
const timed = async (expr: string, scope = {}): Promise<{ value?: unknown; error?: string; ms: number }> => {
  const t0 = performance.now();
  const out = await evaluate(expr, scope).then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  return { ...out, ms: performance.now() - t0 };
};

describe('built-ins with size limits', () => {
  it('ranges and sequences are capped', async () => {
    expect((await timed(`[1..${MAX_SEQUENCE + 1}]`)).error).toMatch(/sequence length/i);
    expect((await timed(`$count([1..${MAX_SEQUENCE}])`)).value).toBe(MAX_SEQUENCE);
  });

  it('$pad refuses huge widths quickly and still pads normally', async () => {
    const r = await timed('$length($pad("", 50000000))');
    expect(r.error).toMatch(/\$pad: the width is limited to 10000/);
    expect(r.ms).toBeLessThan(200);
    expect((await timed('$pad("7", -3, "0")')).value).toBe('007');
    expect((await timed(`$length($pad("x", ${MAX_PAD}, "ab"))`)).value).toBe(MAX_PAD);
  });

  it('$string refuses values whose text would be enormous', async () => {
    const big = {
      rows: Array.from({ length: 200_000 }, (_, i) => ({ id: `row-${i}`, note: 'x'.repeat(40) })),
    };
    expect((await timed('$string(rows)', big)).error).toMatch(/\$string: the value is too large/);
    expect((await timed('$string({"a": 1.1234567890123456, "b": [1, "x"]})')).value).toBe(
      '{"a":1.12345678901235,"b":[1,"x"]}',
    );
  });

  it('$join and $replace refuse results over the text limit', async () => {
    expect((await timed('$join([1..1000000].$pad("", 100), ",")')).error).toBeDefined();
    expect((await timed('$replace($pad("", 10000, "a"), "a", $pad("", 10000, "b"))')).error).toMatch(
      /\$replace: the result could exceed/,
    );
    expect((await timed('$join(["a", "b"], ", ")')).value).toBe('a, b');
    expect((await timed('$replace("a-b-c", "-", "+", 1)')).value).toBe('a+b-c');
  });

  it('$sort is O(n log n): a million numbers sort quickly; JSONata semantics kept', async () => {
    const r = await timed('$count($sort([1..1000000]))');
    expect(r.value).toBe(1_000_000);
    expect(r.ms).toBeLessThan(2000);
    expect((await timed('$sort([3, 1, 2])')).value).toEqual([1, 2, 3]);
    expect((await timed('$sort(["b", "a", "c"])')).value).toEqual(['a', 'b', 'c']);
    expect((await timed('$sort([1, "a"])')).error).toMatch(/array of strings or an array of numbers/);
    // A comparator returning true puts the second value first; ties keep their order (stable).
    expect(
      (
        await timed(
          '$sort([{"n":"b","k":2},{"n":"a","k":1},{"n":"c","k":2}], function($x, $y){ $x.k > $y.k }).n',
        )
      ).value,
    ).toEqual(['a', 'b', 'c']);
  });

  it('$sort with a comparator still obeys the expression timeout', async () => {
    const r = await timed('$count($sort([1..200000], function($a, $b){ $a < $b }))');
    expect(r.error).toMatch(/timed out/);
    expect(r.ms).toBeLessThan(1500);
  });

  it('$distinct is O(n) with deep equality (key order ignored, types kept apart)', async () => {
    const r = await timed('$count($distinct([1..1000000]))');
    expect(r.value).toBe(1_000_000);
    expect(r.ms).toBeLessThan(2000);
    expect(
      (await timed('$distinct([1, "1", 1, {"a":1,"b":[2]}, {"b":[2],"a":1}, true, "true"])')).value,
    ).toEqual([1, '1', { a: 1, b: [2] }, true, 'true']);
    expect(
      (await timed('$distinct(rows.city)', { rows: [{ city: 'Oslo' }, { city: 'Rome' }, { city: 'Oslo' }] }))
        .value,
    ).toEqual(['Oslo', 'Rome']);
  });

  it('$eval is disabled at runtime and reported by validation', async () => {
    expect((await timed('$eval("1 + 1")')).error).toMatch(/\$eval is not available/);
    expect(
      validateExpressions({ a: '${ $eval(params.code) }', b: '${ $map([1], $eval) }' }).map((i) => i.path),
    ).toEqual(['a', 'b']);
  });
});

describe('lint: user data in a request path or url needs $encode()', () => {
  const lint = (def: unknown) => lintExpressions(def).map((i) => `${i.path}: ${i.message}`);

  it.each([
    [{ request: { path: '/users/${ params.id }/memberOf' } }],
    [{ request: { path: "${ '/users/' & params.id }" } }],
    [{ steps: [{ path: '/groups/${ inputs.groupId }/members' }] }],
    [{ request: { body: { requests: [{ url: '/users/${ row.id }' }] } } }],
    // A whole path from row data too (S-13: only a guid or entity param may be a whole path).
    [{ request: { path: '${ row.id }' } }],
  ])('warns for %j', (def) =>
    expect(lint(def)).toEqual([
      expect.stringMatching(/User data is placed in the (path|url) without \$encode\(\)/),
    ]),
  );

  it.each([
    [{ request: { path: '/users/${ $encode(params.id) }/memberOf' } }],
    [{ request: { path: '/users/${ $encode($guid(params.id)) }' } }],
    [{ request: { path: "/groups/x/${ params.scope = 'Transitive' ? 'transitiveMembers' : 'members' }" } }],
    [{ request: { path: "/users/${ params.kind in ['a', 'b'] ? params.kind : 'c' }" } }],
    [{ check: { url: "${ env.PUBLIC_BASE_URL & '/readyz' }" } }],
  ])('accepts %j', (def) => expect(lint(def)).toEqual([]));
});
