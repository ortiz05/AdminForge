import { applyAdvanced, evaluate, HELPER_NAMES, type RowsFilterGroup } from '@adminforge/expressions';

const ROWS = [
  {
    name: 'Adele Vance',
    mail: 'adele@example.com',
    type: 'UserMailbox',
    created: '2026-02-03T04:05:06Z',
    hold: true,
    size: 12,
    tags: ['VIP', 'Sales'],
    owner: { displayName: 'Lee Gu' },
  },
  {
    name: 'Reception',
    mail: 'reception@example.com',
    type: 'SharedMailbox',
    created: '2025-06-01T00:00:00Z',
    hold: false,
    size: 3,
    tags: [],
    owner: null,
  },
  {
    name: 'Room 1',
    mail: 'room1@sub.example.com',
    type: 'RoomMailbox',
    created: null,
    hold: false,
    size: 0,
    tags: ['Building A'],
  },
];
const names = (g: RowsFilterGroup | undefined | null) =>
  applyAdvanced(ROWS, g).map((r) => (r as { name: string }).name);
const all = (...clauses: RowsFilterGroup['clauses']): RowsFilterGroup => ({ join: 'and', clauses });

describe('$applyAdvanced (filters.advanced.dialect: rows)', () => {
  it('returns every row when there is no filter, and copes with a single object or nothing', () => {
    expect(names(undefined)).toEqual(['Adele Vance', 'Reception', 'Room 1']);
    expect(names(null)).toHaveLength(3);
    expect(applyAdvanced(ROWS[0], undefined)).toEqual([ROWS[0]]);
    expect(applyAdvanced(undefined, all())).toEqual([]);
  });

  it('compares text case-insensitively (eq, ne, startsWith, contains, in)', () => {
    expect(names(all({ path: 'type', type: 'enum', op: 'eq', value: 'usermailbox' }))).toEqual([
      'Adele Vance',
    ]);
    expect(names(all({ path: 'type', type: 'enum', op: 'ne', value: 'UserMailbox' }))).toEqual([
      'Reception',
      'Room 1',
    ]);
    expect(names(all({ path: 'name', type: 'string', op: 'startsWith', value: 'RE' }))).toEqual([
      'Reception',
    ]);
    expect(names(all({ path: 'mail', type: 'string', op: 'contains', value: '@SUB.' }))).toEqual(['Room 1']);
    expect(
      names(all({ path: 'type', type: 'enum', op: 'in', value: ['RoomMailbox', 'SharedMailbox'] })),
    ).toEqual(['Reception', 'Room 1']);
  });

  it('compares dates as instants and numbers and booleans by value', () => {
    expect(
      names(all({ path: 'created', type: 'date', op: 'ge', value: '2026-01-01T00:00:00.000Z' })),
    ).toEqual(['Adele Vance']);
    expect(
      names(all({ path: 'created', type: 'date', op: 'lt', value: '2026-01-01T00:00:00.000Z' })),
    ).toEqual(['Reception']);
    expect(names(all({ path: 'size', type: 'number', op: 'gt', value: 2 }))).toEqual([
      'Adele Vance',
      'Reception',
    ]);
    expect(names(all({ path: 'hold', type: 'boolean', op: 'eq', value: true }))).toEqual(['Adele Vance']);
  });

  it('handles missing values, nested paths, list fields and isEmpty', () => {
    expect(names(all({ path: 'created', type: 'date', op: 'isEmpty', value: null }))).toEqual(['Room 1']);
    expect(names(all({ path: 'owner.displayName', type: 'string', op: 'eq', value: 'lee gu' }))).toEqual([
      'Adele Vance',
    ]);
    // A row without the field matches nothing but `ne`.
    expect(names(all({ path: 'owner.displayName', type: 'string', op: 'ne', value: 'Lee Gu' }))).toEqual([
      'Reception',
      'Room 1',
    ]);
    expect(names(all({ path: 'tags', type: 'string', op: 'eq', value: 'sales' }))).toEqual(['Adele Vance']);
    expect(names(all({ path: 'tags', type: 'string', op: 'isEmpty', value: null }))).toEqual(['Reception']);
  });

  it('joins conditions with and/or, one level of nesting', () => {
    const g: RowsFilterGroup = {
      join: 'or',
      clauses: [
        { path: 'hold', type: 'boolean', op: 'eq', value: true },
        {
          join: 'and',
          clauses: [
            { path: 'type', type: 'enum', op: 'eq', value: 'RoomMailbox' },
            { path: 'size', type: 'number', op: 'le', value: 0 },
          ],
        },
      ],
    };
    expect(names(g)).toEqual(['Adele Vance', 'Room 1']);
  });

  it('refuses anything that is not a validated filter', () => {
    expect(() => applyAdvanced(ROWS, 'hold eq true')).toThrow(/not a query-builder filter/);
    expect(() => applyAdvanced(ROWS, { join: 'xor', clauses: [] })).toThrow(/join must be and\/or/);
    expect(() =>
      applyAdvanced(ROWS, all({ path: 'constructor.prototype', type: 'string', op: 'eq', value: 'x' })),
    ).not.toThrow();
    expect(() =>
      applyAdvanced(ROWS, all({ path: '__proto__[0]', type: 'string', op: 'eq', value: 'x' })),
    ).toThrow(/invalid path/);
    expect(() =>
      applyAdvanced(ROWS, all({ path: 'name', type: 'string', op: 'matches' as 'eq', value: 'x' })),
    ).toThrow(/invalid operator/);
    const deep = { join: 'and', clauses: [{ join: 'and', clauses: [{ join: 'and', clauses: [] }] }] };
    expect(() => applyAdvanced(ROWS, deep)).toThrow(/nested too deeply/);
    // Inherited properties are not fields.
    expect(names(all({ path: 'constructor', type: 'string', op: 'isEmpty', value: null }))).toHaveLength(3);
  });

  it('is available in expressions as $applyAdvanced(rows, advanced)', async () => {
    expect(HELPER_NAMES).toContain('applyAdvanced');
    const out = await evaluate('$applyAdvanced(value.rows, advanced).name', {
      value: { rows: ROWS },
      advanced: all({ path: 'type', type: 'enum', op: 'eq', value: 'SharedMailbox' }),
    });
    expect(out).toBe('Reception');
    expect(await evaluate('$count($applyAdvanced(value.rows, advanced))', { value: { rows: ROWS } })).toBe(3);
  });
});
