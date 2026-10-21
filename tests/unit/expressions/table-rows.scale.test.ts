import { evaluate, tableRows, withShare } from '@adminforge/expressions';

// Columnar answers (Azure Cost Management `properties`, Log Analytics tables) as objects, and a row's share of a total —
// natively, so cost views over thousands of rows stay inside a transform's budget.
const answer = {
  columns: [{ name: 'Cost' }, { name: 'ServiceName' }, { name: 'Currency' }, { name: 'Tag Value' }],
  rows: [
    [120, 'Virtual Machines', 'EUR', 'x'],
    [30, 'Storage', 'EUR', null],
    [50, '', 'EUR', 'y'],
  ],
};

describe('$tableRows', () => {
  it('keys every row by column name, leaving out columns that are not plain field names', () => {
    expect(tableRows(answer)).toEqual([
      { Cost: 120, ServiceName: 'Virtual Machines', Currency: 'EUR' },
      { Cost: 30, ServiceName: 'Storage', Currency: 'EUR' },
      { Cost: 50, ServiceName: '', Currency: 'EUR' },
    ]);
  });

  it('picks and renames columns; a column the answer lacks gives no field', () => {
    expect(
      tableRows(answer, { cost: 'Cost', service: 'ServiceName', tag: 'Tag Value', month: 'BillingMonth' }),
    ).toEqual([
      { cost: 120, service: 'Virtual Machines', tag: 'x' },
      { cost: 30, service: 'Storage', tag: null },
      { cost: 50, service: '', tag: 'y' },
    ]);
  });

  it('accepts plain column names and an empty or missing table', () => {
    expect(tableRows({ columns: ['a', 'b'], rows: [[1, 2]] })).toEqual([{ a: 1, b: 2 }]);
    expect(tableRows(undefined)).toEqual([]);
    expect(tableRows({ columns: [{ name: 'a' }] })).toEqual([]);
  });

  it('refuses names that could reach a prototype or the evaluator', () => {
    for (const bad of ['__proto__', 'constructor', '_jsonata_lambda', 'a.b'])
      expect(() => tableRows(answer, { [bad]: 'Cost' })).toThrow(/plain field name|must be an object/);
    expect(() => tableRows(answer, { cost: 1 })).toThrow(/must name a column/);
    expect(() => tableRows('rows')).toThrow(/columns and rows/);
  });

  it('runs inside a transform with the other native helpers', async () => {
    const out = await evaluate(
      "( $r := $tableRows(t, { 'cost': 'Cost', 'service': 'ServiceName' }); { 'total': $sum($pluck($r, 'cost')), 'top': ($r^(>cost))[0].service } )",
      { t: answer },
    );
    expect(out).toEqual({ total: 200, top: 'Virtual Machines' });
  });

  it('turns 5,000 rows into objects well inside the transform budget', async () => {
    const big = {
      columns: answer.columns,
      rows: Array.from({ length: 5000 }, (_, i) => [i, `s${i % 40}`, 'EUR', 't']),
    };
    const t0 = performance.now();
    const out = (await evaluate(
      "( $r := $tableRows(t, { 'cost': 'Cost', 'service': 'ServiceName' }); { 'total': $sum($pluck($r, 'cost')), 'n': $count($withShare($r^(>cost), 'cost', 'share')) } )",
      { t: big },
    )) as { total: number; n: number };
    expect(out).toEqual({ total: (4999 * 5000) / 2, n: 5000 });
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('$withShare', () => {
  it('adds each row’s share of the total; rows without a number count as 0', () => {
    expect(withShare([{ c: 30 }, { c: 10 }, { c: 'n/a' }, 'x'], 'c', 'share')).toEqual([
      { c: 30, share: 0.75 },
      { c: 10, share: 0.25 },
      { c: 'n/a', share: 0 },
      'x',
    ]);
    expect(withShare([{ c: 0 }], 'c', 'share')).toEqual([{ c: 0, share: 0 }]);
    expect(() => withShare([{ c: 1 }], 'c', '__proto__')).toThrow(/plain field name/);
  });
});
