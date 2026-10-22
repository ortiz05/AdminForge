import { evaluate, withItemCount } from '@adminforge/expressions';

// $withItemCount adds how many items a row holds at a path (a group's expanded members), natively — so a page can
// filter on "fewer than 5 members" with $applyAdvanced and show the count, without JSONata per row.
describe('$withItemCount', () => {
  it("adds the number of the row's items at the path", async () => {
    const rows = [{ id: 'a', members: [{ id: '1' }, { id: '2' }] }, { id: 'b', members: [] }, { id: 'c' }];
    expect(await evaluate('$withItemCount(rows, "members", "memberCount")', { rows })).toEqual([
      { id: 'a', members: [{ id: '1' }, { id: '2' }], memberCount: 2 },
      { id: 'b', members: [], memberCount: 0 },
      { id: 'c', memberCount: 0 },
    ]);
  });

  it('reads through lists, skips blank items and counts a single value as one', async () => {
    const rows = [
      { m: [{ id: '1' }, { id: null }, { id: '' }, {}] },
      { m: { id: 'x' } },
      { m: null },
      { m: '' },
    ];
    expect(await evaluate('$withItemCount(rows, "m.id", "n").n', { rows })).toEqual([1, 1, 0, 0]);
    expect(await evaluate('$withItemCount(rows, "m", "n").n', { rows })).toEqual([4, 1, 0, 0]);
  });

  it('feeds $applyAdvanced', async () => {
    const rows = [
      { id: 'a', members: [1, 2, 3, 4, 5] },
      { id: 'b', members: [1] },
      { id: 'c', members: [] },
    ];
    const lt5 = { join: 'and', clauses: [{ path: 'memberCount', type: 'number', op: 'lt', value: 5 }] };
    expect(
      await evaluate('$applyAdvanced($withItemCount(rows, "members", "memberCount"), f).id', {
        rows,
        f: lt5,
      }),
    ).toEqual(['b', 'c']);
  });

  it('passes non-object items through and leaves the input alone', () => {
    const rows = [{ m: [1] }, 'text', 3];
    expect(withItemCount(rows, 'm', 'n')).toEqual([{ m: [1], n: 1 }, 'text', 3]);
    expect(rows[0]).toEqual({ m: [1] });
    expect(withItemCount(undefined, 'm', 'n')).toEqual([]);
    expect(withItemCount({ m: [1, 2] }, 'm', 'n')).toEqual([{ m: [1, 2], n: 2 }]);
  });

  it('refuses a bad path or count field', () => {
    expect(() => withItemCount([], 'a..b', 'n')).toThrow(
      '$withItemCount: the path must be field names joined with dots',
    );
    expect(() => withItemCount([], '__proto__', 'n')).toThrow('$withItemCount');
    expect(() => withItemCount([], 'm', '__proto__')).toThrow(
      '$withItemCount: the count field must be a plain field name',
    );
    expect(() => withItemCount([], 'm', '_jsonata_lambda')).toThrow('$withItemCount: the count field');
    expect(() => withItemCount([], 'm', 3)).toThrow('$withItemCount: the count field');
  });

  it('stops at the evaluation deadline', () => {
    const many = Array.from({ length: 5000 }, () => ({ m: [1] }));
    expect(() => withItemCount(many, 'm', 'n', Date.now() - 1)).toThrow();
  });
});
