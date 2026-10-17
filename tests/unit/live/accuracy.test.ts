import {
  compareRange,
  compareSets,
  compareValue,
  daysUntil,
  exitCodeFor,
  fixtureNames,
  formatOutcomes,
  nameOf,
  outcome,
  rowsOf,
} from '../../live/lib/accuracy';

// The comparison and reporting behind tests/live/scripts/check-accuracy.ts: differences say what was expected and what
// AdminForge showed, documented differences carry their reason, and nothing identifying is printed.
describe('live accuracy comparisons', () => {
  it('finds the rows and names of a datasource result whatever its shape', () => {
    expect(rowsOf({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsOf({ value: [{ b: 2 }] })).toEqual([{ b: 2 }]);
    expect(rowsOf([{ c: 3 }])).toEqual([{ c: 3 }]);
    expect(rowsOf({ total: 3 })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
    expect(nameOf({ displayName: 'AF-Test-User-04', name: 'x' })).toBe('AF-Test-User-04');
    expect(nameOf({ app: 'AF-Test-App-Expiring' })).toBe('AF-Test-App-Expiring');
    expect(nameOf({ id: 1 })).toBeUndefined();
    expect(
      fixtureNames(['AF-Test-B', 'Contoso', 'AF-Audit: x', 'AF-Test-B', undefined, 'AF Tester']),
    ).toEqual(['AF Tester', 'AF-Audit: x', 'AF-Test-B']);
  });

  it('reports missing and unexpected names, values and ranges', () => {
    expect(compareSets('members', ['a', 'b'], ['b', 'c'])).toEqual([
      'members: missing a',
      'members: unexpected c',
    ]);
    expect(compareSets('members', ['a'], ['a'])).toEqual([]);
    expect(compareValue('owners', 1, 1)).toEqual([]);
    expect(compareValue('owners', 1, 2)).toEqual(['owners: expected 1, AdminForge shows 2']);
    expect(compareValue('dept', 'AF-Test Sales', null)).toEqual([
      'dept: expected “AF-Test Sales”, AdminForge shows null',
    ]);
    expect(compareValue('both empty', null, undefined)).toEqual([]);
    expect(compareValue('lists', ['x', 'y'], ['x', 'y'])).toEqual([]);
    expect(compareValue('objects', { a: 1, b: [2] }, { b: [2], a: 1 })).toEqual([]);
    expect(compareRange('days', 6, 5, 7)).toEqual([]);
    expect(compareRange('days', 9, 5, 7)).toEqual(['days: expected 5–7, AdminForge shows 9']);
    expect(compareRange('days', undefined, 5, 7)).toEqual(['days: expected 5–7, AdminForge shows nothing']);
  });

  it('classifies outcomes and exits non-zero only on unexplained mismatches', () => {
    const ok = outcome('identity.users#users', 'users', []);
    const bad = outcome('identity.group#owners', 'owners', ['owners: expected 2, AdminForge shows 1']);
    const why = outcome(
      'identity.auth-registration#byFeature',
      'total',
      ['total: expected 12, AdminForge shows 8'],
      'refreshed every few hours',
    );
    expect([ok.status, bad.status, why.status]).toEqual(['match', 'mismatch', 'documented']);
    expect(why.details.at(-1)).toBe('why: refreshed every few hours');
    expect(exitCodeFor([ok, why])).toBe(0);
    expect(exitCodeFor([ok, bad])).toBe(1);
  });

  it('masks ids, addresses and tenant domains in every printed line', () => {
    const lines = formatOutcomes([
      outcome('identity.user#profile', 'profile', [
        'manager: expected “af-test-user-07@contoso.onmicrosoft.com”, AdminForge shows “0f1e2d3c-4b5a-4678-9abc-def012345678”',
      ]),
      {
        page: 'identity.x#y',
        check: 'not published',
        status: 'unknowable',
        details: ['not published on this AdminForge'],
      },
    ]);
    const text = lines.join('\n');
    expect(text).not.toMatch(/contoso|0f1e2d3c/);
    expect(text).toContain('<address>');
    expect(text).toContain('<id>');
    expect(lines.at(-1)).toBe(
      '2 checks on 2 definitions: 0 match, 1 mismatch, 0 documented difference, 1 not knowable.',
    );
  });

  it('counts whole days to an expiry', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(daysUntil('2026-10-24T12:00:00Z', now)).toBe(7);
    expect(daysUntil('2026-10-16T12:00:00Z', now)).toBe(-1);
    expect(daysUntil(undefined, now)).toBeUndefined();
    expect(daysUntil('not a date', now)).toBeUndefined();
  });
});
