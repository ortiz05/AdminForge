import {
  applyAdvanced,
  attach,
  compile,
  evaluate,
  pick,
  pluck,
  unnest,
  withCount,
  withFields,
} from '@adminforge/expressions';

// $pluck, $unnest and $attach do natively what JSONata paths, per-row blocks and lookups do in O(n) steps of the
// evaluator (too slow for tens of thousands of rows within the 250 ms budget). They read own properties only, never
// write prototype keys or JSONata internals, stay within MAX_SEQUENCE and honour the evaluation's deadline.

const rows = [
  { id: 'u1', name: "O'Brien", sku: 's1', licences: [{ skuId: 's1' }, { skuId: 's2' }], tags: ['a', 'b'] },
  { id: 'u2', name: 'Ελένη', sku: 's2', licences: [], tags: 'c' },
  { id: 'u3', name: '王伟', sku: null, licences: [{ skuId: 's1' }] },
  { id: 'u4', name: 'No list' },
];
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
// JSONata's own evaluation (compile() leaves out the native rewrites).
const jsonataEval = async (expr: string, data: unknown) => plain(await compile(expr).evaluate(data));

describe('$pluck', () => {
  it('matches the JSONata path without nulls, flattening lists on the way', async () => {
    expect(await evaluate('$pluck(rows, "id")', { rows })).toEqual(await jsonataEval('rows.id', { rows }));
    expect(await evaluate('$pluck(rows, "sku")', { rows })).toEqual(['s1', 's2']);
    expect(await evaluate('$pluck(rows, "licences.skuId")', { rows })).toEqual(
      await jsonataEval('rows.licences.skuId', { rows }),
    );
    expect(await evaluate('$pluck(rows, "tags")', { rows })).toEqual(['a', 'b', 'c']);
    expect(await evaluate('$distinct($pluck(rows, "licences.skuId"))', { rows })).toEqual(['s1', 's2']);
  });

  it('a single row, no rows, and inherited properties', async () => {
    expect(await evaluate('$pluck(row, "id")', { row: rows[0] })).toEqual(['u1']);
    expect(await evaluate('$pluck(none, "id")', {})).toEqual([]);
    expect(pluck([{}], 'toString')).toEqual([]);
    expect(() => pluck([{}], 'constructor.name')).toThrow(/can't name/);
  });

  it('refuses bad paths', () => {
    expect(() => pluck(rows, '__proto__')).toThrow(/can't name/);
    expect(() => pluck(rows, 'a[0]')).toThrow(/dots/);
    expect(() => pluck(rows, '')).toThrow(/dots/);
  });
});

describe('$unnest', () => {
  it('one row per item, the item under the name; empty and missing lists leave the row out', async () => {
    const out = (await evaluate('$unnest(rows, "licences", "licence")', { rows })) as Array<
      Record<string, unknown>
    >;
    expect(out.map((r) => [r.id, (r.licence as { skuId: string }).skuId])).toEqual([
      ['u1', 's1'],
      ['u1', 's2'],
      ['u3', 's1'],
    ]);
    // Same as the per-row block it replaces.
    expect(plain(out.map((r) => ({ id: r.id, sku: (r.licence as { skuId: string }).skuId })))).toEqual(
      await jsonataEval('[rows.($u := $; licences.{ "id": $u.id, "sku": skuId })]', { rows }),
    );
    // A single value is a one-item list; the original rows are untouched.
    expect(unnest(rows, 'tags', 't').map((r) => (r as { t: string }).t)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).not.toHaveProperty('licence');
  });

  it('leaves the unnested list out of the new rows (one field), keeping every other field', () => {
    const [first] = unnest(rows, 'licences', 'licence') as Array<Record<string, unknown>>;
    expect(first).not.toHaveProperty('licences');
    expect(first).toMatchObject({ id: 'u1', name: "O'Brien", sku: 's1', tags: ['a', 'b'] });
    // A dotted path: the object holding the list is copied without it; an own "__proto__" key is copied as a key.
    const nested = unnest([{ id: 'x', a: { l: [1] } }], 'a.l', 'item') as Array<Record<string, unknown>>;
    expect(nested[0]).toEqual({ id: 'x', a: {}, item: 1 });
    const odd = unnest([JSON.parse('{"__proto__": {"polluted": true}, "l": [1]}')], 'l', 'item') as Array<
      Record<string, unknown>
    >;
    expect(Object.getPrototypeOf(odd[0])).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(odd[0], '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses names that would reach a prototype or JSONata internals', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype', '_jsonata_lambda', 'a.b', '1x']) {
      expect(() => unnest(rows, 'licences', bad)).toThrow(/plain field name/);
      expect(() => unnest(rows, 'licences', 'licence', undefined, bad)).toThrow(/plain field name/);
    }
  });

  it('a key per new row: the row id and the item position', async () => {
    const out = (await evaluate('$unnest(rows, "licences", "licence", "key").key', { rows })) as string[];
    expect(out).toEqual(['u1:licences:0', 'u1:licences:1', 'u3:licences:0']);
    expect(unnest([{ l: [1, 2] }], 'l', 'x', undefined, 'k').map((r) => (r as { k: string }).k)).toEqual([
      '@0:l:0',
      '@0:l:1',
    ]);
    // No key given (null) is the same as leaving it out.
    expect(await evaluate('$count($unnest(rows, "licences", "licence", null))', { rows })).toBe(3);
  });

  it('keys stay unique across text ids, numeric ids and positions', () => {
    const odd = [
      { l: [1] },
      { id: '0', l: [2] },
      { id: 0, l: [3] },
      { id: '@0', l: [4] },
      { id: '!@0', l: [5] },
    ];
    const keys = unnest(odd, 'l', 'x', undefined, 'k').map((r) => (r as { k: string }).k);
    expect(keys).toEqual(['@0:l:0', '0:l:0', '#0:l:0', '!@0:l:0', '!!@0:l:0']);
    expect(new Set(keys).size).toBe(keys.length);
    // An inherited id is no id.
    expect(
      (
        unnest(
          [Object.create({ id: 'x' }, { l: { value: [1], enumerable: true } })],
          'l',
          'x',
          undefined,
          'k',
        )[0] as { k: string }
      ).k,
    ).toBe('@0:l:0');
  });

  it('a dotted path copies the objects along it without the list, so no row carries the whole list', () => {
    const row = { id: 'x', api: { name: 'Graph', scopes: ['a', 'b', 'c'] } };
    const out = unnest([row], 'api.scopes', 's') as Array<Record<string, unknown>>;
    expect(out).toEqual([
      { id: 'x', api: { name: 'Graph' }, s: 'a' },
      { id: 'x', api: { name: 'Graph' }, s: 'b' },
      { id: 'x', api: { name: 'Graph' }, s: 'c' },
    ]);
    expect(row.api.scopes).toHaveLength(3); // the input is untouched
    // Through a list on the way, the first field is left out whole.
    const through = unnest([{ id: 'y', apis: [{ scopes: [1, 2] }, { scopes: [3] }] }], 'apis.scopes', 's');
    expect(through).toEqual([
      { id: 'y', s: 1 },
      { id: 'y', s: 2 },
      { id: 'y', s: 3 },
    ]);
  });

  it('checks the budget by rows written, not only rows read', () => {
    let calls = 0;
    const budget = () => {
      if (++calls > 1) throw new Error('budget spent');
    };
    expect(() => unnest([{ l: Array.from({ length: 10_000 }, (_, i) => i) }], 'l', 'x', budget)).toThrow(
      'budget spent',
    );
  });
});

describe('$attach', () => {
  const tiers = { s1: { skuName: 'E5', paid: true }, s2: { skuName: 'Free', paid: false } };

  it('adds the lookup entry of each row; rows without one are unchanged', async () => {
    const out = (await evaluate('$attach(rows, "sku", tiers)', { rows, tiers })) as Array<
      Record<string, unknown>
    >;
    expect(out.map((r) => [r.id, r.skuName ?? null])).toEqual([
      ['u1', 'E5'],
      ['u2', 'Free'],
      ['u3', null],
      ['u4', null],
    ]);
    expect(rows[0]).not.toHaveProperty('skuName');
  });

  it('a row without a match gets the defaults, when given (checked like entries)', async () => {
    const out = (await evaluate('$attach(rows, "sku", tiers, { "skuName": "Unknown", "paid": null })', {
      rows,
      tiers,
    })) as Array<Record<string, unknown>>;
    expect(out.map((r) => r.skuName)).toEqual(['E5', 'Free', 'Unknown', 'Unknown']);
    // Merged by spread: a "__proto__" key stays a plain key and never becomes the row's prototype.
    const [odd] = attach(
      [{ sku: 'none' }],
      'sku',
      tiers,
      JSON.parse('{"__proto__": {"polluted": true}}'),
    ) as Array<Record<string, unknown>>;
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
    expect(Object.hasOwn(odd!, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => attach(rows, 'sku', tiers, [])).toThrow(/defaults must be an object/);
  });

  it('several id fields against one lookup, each under its own name, in one pass', async () => {
    const objects = { c1: { name: 'App' }, r1: { name: 'Graph' }, u1: { name: 'Avery' } };
    const grants = [
      { id: 'g1', clientId: 'c1', resourceId: 'r1', principalId: 'u1' },
      { id: 'g2', clientId: 'c9', resourceId: 'r1', principalId: null },
    ];
    const out = (await evaluate(
      '$attach(grants, ["clientId", "resourceId", "principalId"], objects, { "client": { "name": "Unknown" } }, ["client", "resource", "who"])',
      { grants, objects },
    )) as Array<Record<string, { name?: string } | undefined>>;
    expect(out.map((r) => [r.client?.name, r.resource?.name, r.who?.name ?? null])).toEqual([
      ['App', 'Graph', 'Avery'],
      ['Unknown', 'Graph', null],
    ]);
    expect(() => attach(grants, ['clientId', 'resourceId'], objects, null, undefined, ['client'])).toThrow(
      /one field per path/,
    );
    expect(() => attach(grants, ['clientId'], objects, null, undefined, ['__proto__'])).toThrow(
      /plain field name/,
    );
  });

  it('joins with a table built once per distinct value', async () => {
    const out = await evaluate(
      '($t := $distinct($pluck(rows, "sku")){ $: { "label": "SKU " & $ } }; $attach(rows, "sku", $t).label)',
      { rows },
    );
    expect(out).toEqual(['SKU s1', 'SKU s2']);
  });

  it('reads the lookup as own properties only and refuses unsafe entries', () => {
    expect(attach([{ k: 'toString' }], 'k', {})).toEqual([{ k: 'toString' }]);
    expect(attach([{ k: '__proto__' }], 'k', JSON.parse('{"__proto__": {"x": 1}}'))).toEqual([
      { k: '__proto__', x: 1 },
    ]);
    const [merged] = attach(
      [{ k: 'a' }],
      'k',
      JSON.parse('{"a": {"__proto__": {"polluted": true}}}'),
    ) as Array<Record<string, unknown>>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged!.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => attach([{ k: 'a' }], 'k', [])).toThrow(/must be an object/);
  });

  it('refuses functions as the lookup or inside an entry', async () => {
    await expect(
      evaluate('$attach(rows, "sku", { "s1": { "f": function() { 1 } } })', { rows }),
    ).rejects.toThrow(/can't be a function/);
    await expect(evaluate('$attach(rows, "sku", function() { 1 })', { rows })).rejects.toThrow();
  });
});

describe('budget', () => {
  it('a helper stops at the evaluation deadline', () => {
    const past = Date.now() - 1;
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: String(i) }));
    expect(() => pluck(many, 'id', past)).toThrow();
    expect(() => unnest(many, 'id', 'x', past)).toThrow();
    expect(() => attach(many, 'id', {}, undefined, past)).toThrow();
  });

  // 25,000 rows (50,000 written) leave room for a busy test run; the content scale tests and `pnpm test:perf` cover
  // the reports at enterprise size.
  it('25,000 rows: pluck, unnest and attach within the 250 ms budget', { retry: 2 }, async () => {
    const big = Array.from({ length: 25_000 }, (_, i) => ({
      id: `u${i}`,
      sku: `s${i % 50}`,
      l: [{ s: 1 }, { s: 2 }],
    }));
    const t0 = performance.now();
    const out = await evaluate(
      '($t := $distinct($pluck(rows, "sku")){ $: { "label": "SKU " & $ } }; $count($attach($unnest(rows, "l", "x"), "sku", $t)))',
      { rows: big },
    );
    expect(out).toBe(50_000);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('$withCount', () => {
  it('how many rows share the value; rows without one get 0', async () => {
    const secrets = [{ app: 'a' }, { app: 'b' }, { app: 'a' }, { app: 1 }, { app: '1' }, {}];
    const out = (await evaluate('$withCount(rows, "app", "n").n', { rows: secrets })) as number[];
    // Compared as text, as $attach joins (1 and "1" are one value).
    expect(out).toEqual([2, 1, 2, 2, 2, 0]);
    expect(() => withCount(secrets, 'app', '__proto__')).toThrow(/plain field name/);
  });
});

describe('$applyAdvanced: date shifted by days', () => {
  const creds = [
    { id: 'year', startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' },
    { id: 'two', startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2028-01-01T00:00:00Z' },
    { id: 'none', endDateTime: '2028-01-01T00:00:00Z' },
  ];
  it('end later than start plus N days', () => {
    const longer = (days: number) =>
      (
        applyAdvanced(creds, {
          join: 'and',
          clauses: [
            { path: 'endDateTime', type: 'date', op: 'gt', field: 'startDateTime', days, value: null },
          ],
        }) as Array<{ id: string }>
      ).map((c) => c.id);
    expect(longer(365)).toEqual(['two']);
    expect(longer(300)).toEqual(['year', 'two']);
  });
  it('days needs a field and a date', () => {
    expect(() =>
      applyAdvanced(creds, {
        join: 'and',
        clauses: [{ path: 'endDateTime', type: 'date', op: 'gt', days: 1, value: null }],
      }),
    ).toThrow(/days needs a field/);
    expect(() =>
      applyAdvanced(creds, {
        join: 'and',
        clauses: [{ path: 'id', type: 'string', op: 'gt', field: 'id', days: 1, value: null }],
      }),
    ).toThrow(/days needs a field/);
  });
});

describe('functions are not data', () => {
  // A JSONata lambda or built-in is an object with the evaluator's internals (its environment, its implementation).
  const fn = { _jsonata_lambda: true, environment: { base: {} }, body: {} };

  it('paths never read into a function', async () => {
    expect(await evaluate('$pluck([function($x) { $x }], "environment.base")')).toEqual([]);
    expect(await evaluate('$pluck([$string], "implementation")')).toEqual([]);
    expect(pluck([{ f: fn }], 'f.environment')).toEqual([]);
    expect(
      applyAdvanced([fn], {
        join: 'and',
        clauses: [{ path: 'environment', type: 'string', op: 'notEmpty', value: null }],
      }),
    ).toEqual([]);
  });

  it('function rows pass through every helper unchanged, never copied', () => {
    expect(attach([fn], 'body', {}, { y: 1 })[0]).toBe(fn);
    expect(attach([fn], ['body'], {}, { b: { y: 1 } }, undefined, ['b'])[0]).toBe(fn);
    expect(withCount([fn], 'body', 'n')[0]).toBe(fn);
    expect(pick([fn], ['environment'])[0]).toBe(fn);
    expect(withFields([fn], { y: 1 })[0]).toBe(fn);
    expect(unnest([fn], 'body', 'x')).toEqual([]);
  });
});

describe('limits', () => {
  it('at most 64 fields for $pick and 64 paths for $attach', () => {
    const names = Array.from({ length: 65 }, (_, i) => `f${i}`);
    expect(() => pick([{}], names)).toThrow(/at most 64/);
    expect(() => attach([{}], names, {}, null, undefined, names)).toThrow(/at most 64/);
    expect(pick([{ f0: 1 }], names.slice(0, 64))).toEqual([{ f0: 1 }]);
  });

  it('a path that reads more than a million values stops', () => {
    const half = Array.from({ length: 600_000 }, () => 1);
    expect(() => pluck([{ a: [{ b: half }, { b: half }] }], 'a.b')).toThrow(/more than 1000000/);
  });

  it('a result is bounded by the values it holds (a shared list copied into every row)', async () => {
    const shared = Array.from({ length: 6000 }, (_, i) => i);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ i }));
    await expect(evaluate('$withFields(rows, { "all": shared })', { rows, shared })).rejects.toThrow(
      /too large/,
    );
  });

  it('merged lookup fields may be Graph keys, never JSONata internals', () => {
    expect(attach([{ k: 'a' }], 'k', { a: { '@odata.type': '#microsoft.graph.user' } })).toEqual([
      { k: 'a', '@odata.type': '#microsoft.graph.user' },
    ]);
    expect(() => attach([{ k: 'a' }], 'k', { a: { _jsonata_flag: true } })).toThrow(/field name/);
    // A function as an entry is no entry.
    expect(attach([{ k: 'a' }], 'k', { a: { _jsonata_lambda: true } })).toEqual([{ k: 'a' }]);
  });
});
