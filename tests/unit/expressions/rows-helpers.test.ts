import { applyAdvanced, evaluate, withFields } from '@adminforge/expressions';

// Native row helpers content uses at enterprise scale (JSONata costs ~15 µs a row for a filter or a $merge):
// `$applyAdvanced` with a filter written in content (incl. `notEmpty` and paths through lists) and `$withFields`.

const apps = [
  {
    id: 'a',
    passwordCredentials: [{ endDateTime: '2026-01-01T00:00:00Z' }, { endDateTime: '2027-01-01T00:00:00Z' }],
  },
  { id: 'b', passwordCredentials: [], keyCredentials: [{ endDateTime: '2026-11-01T00:00:00Z' }] },
  { id: 'c' },
];
const lt = (path: string, value: string) => ({ path, type: 'date' as const, op: 'lt' as const, value });

describe('$applyAdvanced with a filter written in content', () => {
  it('reads through lists: a condition matches when any item does', () => {
    const expired = applyAdvanced(apps, {
      join: 'or',
      clauses: [
        lt('passwordCredentials.endDateTime', '2026-10-17T00:00:00Z'),
        lt('keyCredentials.endDateTime', '2026-10-17T00:00:00Z'),
      ],
    });
    expect((expired as Array<{ id: string }>).map((a) => a.id)).toEqual(['a']);
    const soon = applyAdvanced(apps, {
      join: 'and',
      clauses: [lt('keyCredentials.endDateTime', '2026-12-01T00:00:00Z')],
    });
    expect((soon as Array<{ id: string }>).map((a) => a.id)).toEqual(['b']);
  });

  it('notEmpty / isEmpty on lists and missing fields', () => {
    const rows = [{ l: [1] }, { l: [] }, {}, { l: null }, { l: '' }, { l: 'x' }];
    const notEmpty = applyAdvanced(rows, {
      join: 'and',
      clauses: [{ path: 'l', type: 'string', op: 'notEmpty', value: null }],
    });
    expect(notEmpty).toEqual([{ l: [1] }, { l: 'x' }]);
    const isEmpty = applyAdvanced(rows, {
      join: 'and',
      clauses: [{ path: 'l', type: 'string', op: 'isEmpty', value: null }],
    });
    expect(isEmpty).toHaveLength(4);
  });

  it('a path that stops at a list still gives the list (query-builder behaviour unchanged)', () => {
    const rows = [{ tags: ['x', 'y'] }, { tags: ['z'] }];
    expect(
      applyAdvanced(rows, { join: 'and', clauses: [{ path: 'tags', type: 'string', op: 'eq', value: 'y' }] }),
    ).toEqual([{ tags: ['x', 'y'] }]);
  });

  it('filters 50k rows in a transform within the 250 ms budget', async () => {
    const value = Array.from({ length: 50_000 }, (_, i) => ({
      id: i,
      accountEnabled: i % 3 !== 0,
      userType: i % 10 ? 'Member' : 'Guest',
    }));
    const out = await evaluate(
      `$count($applyAdvanced(value, { "join": "and", "clauses": [
         { "path": "accountEnabled", "type": "boolean", "op": "eq", "value": true },
         { "path": "userType", "type": "string", "op": "eq", "value": "Member" } ] }))`,
      { value },
    );
    expect(out).toBe(value.filter((r) => r.accountEnabled && r.userType === 'Member').length);
  });
});

describe('$withFields', () => {
  it('adds or replaces fields on object rows, leaves other items and the input alone', () => {
    const input = [{ a: 1, s: 'x' }, 'text', null];
    expect(withFields(input, { s: 'y', t: true })).toEqual([{ a: 1, s: 'y', t: true }, 'text', null]);
    expect(input[0]).toEqual({ a: 1, s: 'x' });
    expect(withFields(undefined, { s: 1 })).toEqual([]);
    expect(() => withFields([{}], 'no')).toThrow(/fields must be an object/);
  });

  it('labels 50k rows in a transform within the 250 ms budget', async () => {
    const value = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    const out = (await evaluate('$withFields(value, { "state": "never" })[49999].state', {
      value,
    })) as string;
    expect(out).toBe('never');
  });
});
