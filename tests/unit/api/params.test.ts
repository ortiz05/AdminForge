import { defaultTimespan, InvalidParams, resolveDate, resolveParams } from '@adminforge/api/src/datasources/params';
import type { Params } from '@adminforge/schemas';

const NOW = '2026-10-15T12:00:00.000Z';
const scope = { now: NOW, user: { oid: 'u' }, env: {} };

const DECL: Params = {
  q: { type: 'string', default: '', maxLength: 20 },
  userType: { type: 'enum', values: ['All', 'Member', 'Guest'], default: 'All' },
  days: { type: 'enum', values: [{ value: 30, label: '30 days' }, { value: 90, label: '90 days' }], default: 30 },
  tags: { type: 'enum', values: ['a', 'b', 'c'], multiple: true },
  limit: { type: 'number', min: 1, max: 500, integer: true },
  includeExpired: { type: 'boolean', default: true },
  id: { type: 'guid' },
  since: { type: 'date' },
  range: { type: 'dateRange', default: 'P7D', max: 'P31D' },
  owner: { type: 'user' },
  mail: { type: 'string', format: 'email' },
};

describe('resolveParams', () => {
  it('fills defaults and coerces URL-style values to the declared types', async () => {
    const out = await resolveParams(DECL, { days: '90', limit: '25', includeExpired: 'false', tags: 'a,c', id: 'ABCDEF01-2345-4678-89AB-CDEF01234567', since: '-30d' }, scope);
    expect(out).toEqual({
      q: '',
      userType: 'All',
      days: 90,
      tags: ['a', 'c'],
      limit: 25,
      includeExpired: false,
      id: 'abcdef01-2345-4678-89ab-cdef01234567',
      since: '2026-09-15T12:00:00.000Z',
      range: { from: '2026-10-08T12:00:00.000Z', to: NOW, timespan: `2026-10-08T12:00:00.000Z/${NOW}` },
    });
  });

  it('collects every problem: unknown names, bad enum values, ranges, formats', async () => {
    const err = (await resolveParams(DECL, { nope: 1, userType: 'Admin', limit: 0, id: 'x', q: 'x'.repeat(21), range: { from: '2026-01-01', to: '2026-06-01' }, mail: 'not-mail', owner: ['a', 'b'] }, scope).catch(
      (e: unknown) => e,
    )) as InvalidParams;
    expect(err).toBeInstanceOf(InvalidParams);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_params');
    expect(err.issues.map((i) => i.param).sort()).toEqual(['id', 'limit', 'mail', 'nope', 'owner', 'q', 'range', 'userType']);
  });

  it('required params, expression defaults and the Log Analytics timespan', async () => {
    const decl: Params = { id: { type: 'guid', required: true }, n: { type: 'number', default: '${ 2 + 3 }' }, r: { type: 'dateRange', default: 'P1D' } };
    await expect(resolveParams(decl, {}, scope)).rejects.toMatchObject({ issues: [{ param: 'id', message: 'is required' }] });
    const out = await resolveParams(decl, { id: '00000000-0000-4000-8000-000000000001' }, scope);
    expect(out.n).toBe(5);
    expect(defaultTimespan(decl, out)).toBe(`2026-10-14T12:00:00.000Z/${NOW}`);
  });

  it('resolveDate', () => {
    const now = new Date(NOW);
    expect(resolveDate('today', now)).toBe('2026-10-15T00:00:00.000Z');
    expect(resolveDate('+12h', now)).toBe('2026-10-16T00:00:00.000Z');
    expect(resolveDate('2026-01-31', now)).toBe('2026-01-31T00:00:00.000Z');
    expect(resolveDate('soon', now)).toBeUndefined();
  });
});
