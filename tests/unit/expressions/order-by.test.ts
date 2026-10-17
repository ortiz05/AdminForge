import { compile, evaluate } from '@adminforge/expressions';

// `^( … )` is rewritten into a native decorate-sort-undecorate for evaluation (order-by.ts). It must answer exactly
// like JSONata's own sort — order, stability, undefined last, filters after the sort, nested sorts, variables, errors —
// and be fast enough for enterprise-sized lists.

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
  { id: 1, name: 'b', n: 3, at: '2026-01-02', risk: 'high', tags: ['x'] },
  { id: 2, name: 'a', n: 1, at: '2026-01-05', risk: 'low' },
  { id: 3, name: 'c', n: 3, risk: 'medium', tags: ['y'] },
  { id: 4, name: 'a', n: 2, at: '2026-01-01', risk: 'high' },
  { id: 5, name: 'b', n: 1, at: '2026-01-05', risk: 'low', nested: { k: 'z' } },
  { id: 6, name: 'a', n: 3, at: '2026-01-03', risk: 'medium', nested: { k: 'a' } },
];

const SAME: Array<[string, Record<string, unknown>]> = [
  ['rows^(name)', { rows }],
  ['rows^(>name)', { rows }],
  ['rows^(name, >n).id', { rows }],
  ['rows^(>at).id', { rows }], // undefined last, descending too
  ['rows^(at).id', { rows }],
  ['rows^(nested.k).id', { rows }],
  ['rows^(tags).id', { rows }], // one-element arrays stand for their value
  ['rows[n > 1]^(>n, name).id', { rows }],
  ['(rows^(>at))[0].id', { rows }],
  ['(rows^(name, >at))[[0..2]].id', { rows }],
  ['rows^(>at)[0].id', { rows }],
  ["rows^(risk = 'high' ? 0 : risk = 'medium' ? 1 : 2, >at).id", { rows }],
  ['($order := {"high": 0, "medium": 1, "low": 2}; rows^($lookup($order, risk), id).id)', { rows }],
  ['[3, 1, 2]^($)', {}],
  ['[3, 1, 2]^(>$)', {}],
  ["['b', 'a', 'c']^($)", {}],
  ['rows[id = 1]^(name)', { rows }], // one item
  ['rows[id = 99]^(name)', { rows }], // none
  ['$sum(rows^(n).n)', { rows }],
  ['rows.{ "id": id, "sorted": $string(tags^($)) }', { rows }],
  ['(rows^(name)).(id)', { rows }],
  ['{ "top": (rows^(>n, id))[[0..1]].id }', { rows }],
  ['rows^(name)[n = 3].id', { rows }],
  [
    'groups.(members^(>score)).name',
    {
      groups: [
        {
          members: [
            { name: 'p', score: 1 },
            { name: 'q', score: 2 },
          ],
        },
        { members: [{ name: 'r', score: 5 }] },
      ],
    },
  ],
  ['rows^(id)^(name).id', { rows }], // sorts in sequence: the last wins, stably
  // One value, one-item sequences and constant slices follow JSONata's sequence rules.
  ['[3]^($)', {}],
  ['[[1]]^($)', {}],
  ['"s"^($)', {}],
  ['"s"^($)[[0..0]]', {}],
  ['x.tags^($)', { x: { tags: ['x'] } }],
  ['x.one^(v)', { x: { one: [{ v: 1 }] } }],
  ['(x.two^($))[[0..0]]', { x: { two: ['b', 'a'] } }],
  ['(x.two^($))[[5..6]]', { x: { two: ['b', 'a'] } }],
  ['x.two^($)[[0..0]]', { x: { two: ['b', 'a'] } }],
  ['(rows^(>n, id))[[-2..-1]].id', { rows }],
  ['(rows^(>n, id))[[1..3]][n = 3].id', { rows }],
  ['rows^(>n, id)[[0..2]][1].id', { rows }],
  ['$count((rows^(name))[[0..99]])', { rows }],
  // Order-by in the middle of a path: the path goes on from the sorted sequence.
  ['rows^(>n, id).name', { rows }],
  ['rows^(>n)[0].name', { rows }],
  ['rows^(name).{ "i": id, "n": n }', { rows }],
  ['rows^(name)^(>n).id', { rows }],
  ['rows[n > 1]^(name)[[0..1]].id', { rows }],
  [
    'g.members^(>score).name',
    {
      g: [
        {
          members: [
            { name: 'p', score: 1 },
            { name: 'q', score: 9 },
          ],
        },
        { members: [{ name: 'r', score: 5 }] },
      ],
    },
  ],
  ['m.($^($))', { m: [[3, 1], [2]] }],
  [
    'm.($^(>$))[0]',
    {
      m: [
        [3, 1],
        [2, 7],
      ],
    },
  ],
  [
    '$map(g, function($x) { $x.members^(>score).name })',
    {
      g: [
        {
          members: [
            { name: 'p', score: 1 },
            { name: 'q', score: 9 },
          ],
        },
      ],
    },
  ],
];

describe('order-by: same answers as JSONata', () => {
  it.each(SAME)('%s', async (expr, scope) => {
    expect(await fast(expr, scope)).toEqual(await original(expr, scope));
  });

  // Keys JSONata compares only pair by pair: its own sort decides (fallback), so answers and errors are the same.
  it.each([
    [
      'rows^(id, x).id',
      {
        rows: [
          { id: 2, x: 'a' },
          { id: 1, x: 5 },
        ],
      },
    ],
    [
      'rows^(id, b).id',
      {
        rows: [
          { id: 2, b: true },
          { id: 1, b: false },
        ],
      },
    ],
    [
      'rows^(k, x).id',
      {
        rows: [
          { id: 1, k: 1, x: 'a' },
          { id: 2, k: 1, x: 5 },
        ],
      },
    ],
    ['rows^(k).id', { rows: [{ id: 1, k: { a: 1 } }, { id: 2 }] }], // compared only with undefined: no error
    ['rows^(k).id', { rows: [{ id: 1, k: 1 }, { id: 2 }, { id: 3, k: 'a' }] }],
    ['(rows^(id))[[-1..0]].id', { rows: [{ id: 2 }, { id: 1 }] }],
    ['(rows^(id))[[-3..2]].id', { rows: [{ id: 3 }, { id: 1 }, { id: 2 }] }], // every item selected twice
    ['(rows^(id))[[-2..1]].id', { rows: [{ id: 3 }, { id: 1 }, { id: 2 }, { id: 4 }] }],
    ['(rows^(id))[[-9..-8]].id', { rows: [{ id: 3 }, { id: 1 }] }],
    ['(rows^(id))[[2..1]].id', { rows: [{ id: 3 }, { id: 1 }] }],
  ])('%s (unclean keys, negative slices) answers like JSONata', async (expr, scope) => {
    expect(await fast(expr, scope)).toEqual(await original(expr, scope));
  });

  it.each([
    ['rows^(nested).id', 'T2008'], // an object is not sortable
    ['[1, "a"]^($)', 'T2007'], // a number and a string
    ['[{"v": true}, {"v": false}]^(v)', 'T2008'],
  ])('%s fails like JSONata (%s)', async (expr, code) => {
    expect(await original(expr, { rows })).toEqual({ code });
    expect(await fast(expr, { rows })).toEqual({ code });
  });

  it('keeps JSONata’s sort for shapes it doesn’t rewrite (tuples, parent)', async () => {
    for (const expr of ['rows#$i^(>n).id', 'rows@$r^(>$r.n).($r.id)', 'rows.(%^(x))']) {
      expect(await fast(expr, { rows })).toEqual(await original(expr, { rows }));
    }
  });

  it('validation and lint read the expression as written', () => {
    const ast = JSON.stringify(compile('rows^(>at)').ast());
    expect(ast).toContain('"type":"sort"');
    expect(ast).not.toContain('__afOrderBy');
  });
});

describe('order-by at enterprise size', () => {
  const big = Array.from({ length: 100_000 }, (_, i) => ({
    id: i,
    createdDateTime: new Date(1_700_000_000_000 + ((i * 7919) % 100_000) * 60_000).toISOString(),
    name: `User ${(i * 104_729) % 997}`,
  }));

  it('sorts 100k rows by a field and takes the top 10 in well under a second', async () => {
    // Alone this takes ~200 ms (the 250 ms default budget); the bound leaves room for a loaded CI machine. JSONata's
    // own sort needed over a second for 10k rows and ran out of memory at 50k.
    const started = performance.now();
    const out = (await evaluate(
      '(rows^(>createdDateTime))[[0..9]].id',
      { rows: big },
      { timeoutMs: 5000 },
    )) as number[];
    expect(out).toHaveLength(10);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('a term evaluated per row shares the one budget: an O(n) term over 4k rows stops near the budget', async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, m: i % 50 }));
    const started = performance.now();
    await expect(
      evaluate(
        '($all := rows; rows^(($id := id; $count($all[m = $id]))).id)[0]',
        { rows },
        { timeoutMs: 250 },
      ),
    ).rejects.toMatchObject({ code: 'D1012' });
    // Each row used to get a fresh 250 ms (4.3 s here); now it stops within about one budget more.
    expect(performance.now() - started).toBeLessThan(600);
  });

  it('a heavy term stops when the expression’s budget is spent', async () => {
    const started = performance.now();
    await expect(
      evaluate('rows^($count($split($string($), "")) > 0 ? name : name)', { rows: big }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'D1012' });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('sorts 100k rows by two fields, stably', async () => {
    const out = (await evaluate(
      'rows^(name, >createdDateTime).id',
      { rows: big },
      { timeoutMs: 5000 },
    )) as number[];
    expect(out).toHaveLength(100_000);
    const first = big
      .filter((r) => r.name === 'User 0')
      .sort((a, b) => (a.createdDateTime < b.createdDateTime ? 1 : -1));
    expect(out.slice(0, first.length)).toEqual(first.map((r) => r.id));
  });
});
