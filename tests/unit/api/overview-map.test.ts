import { mapOverview, parseCount, sectionError } from '@adminforge/api/src/routes/overview';

describe('overview mapping', () => {
  it.each([
    [42, 42],
    ['42', 42],
    [' 42 ', 42],
    [Buffer.from('1284').toString('base64'), 1284],
    [{ '@odata.count': 7 }, 7],
    ['abc', null],
    [undefined, null],
  ])('parseCount(%j) → %j', (input, expected) => {
    expect(parseCount(input)).toBe(expected);
  });

  it('hints name the missing permission, licence, or transient cause', () => {
    expect(
      sectionError('users', 403, {
        error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' },
      }),
    ).toEqual({
      code: 'Authorization_RequestDenied',
      message: 'Insufficient privileges',
      hint: 'Needs User.Read.All on the Read app.',
    });
    expect(
      sectionError('skus', 403, { error: { message: 'The tenant has no licence for this.' } }).hint,
    ).toMatch(/^Your tenant's licences/);
    expect(sectionError('health', 429, undefined)).toMatchObject({
      code: 'HTTP429',
      hint: expect.stringMatching(/throttled/),
    });
    expect(sectionError('org', 500, undefined).hint).toMatch(/temporary problem/);
  });

  it('falls back to the session tenant when /organization fails and omits errors when all succeed', () => {
    const failed = mapOverview(
      [{ id: 'org', status: 403, body: { error: { code: 'Forbidden', message: 'no' } } }],
      { ms: 5 },
      { tenantId: 't-1', tenantName: 'Example Org' },
    );
    expect(failed.org).toEqual({ id: 't-1', name: 'Example Org', domains: [] });
    expect(failed.errors?.org?.hint).toMatch(/Organization\.Read\.All/);
    expect(failed.errors?.users?.code).toBe('missing');

    const ok = mapOverview(
      [
        {
          id: 'org',
          status: 200,
          body: { value: [{ id: 'o', displayName: 'Example Org', verifiedDomains: [] }] },
        },
        { id: 'users', status: 200, body: 1 },
        { id: 'groups', status: 200, body: 2 },
        { id: 'apps', status: 200, body: 3 },
        { id: 'devices', status: 200, body: 4 },
        { id: 'skus', status: 200, body: { value: [] } },
        { id: 'health', status: 200, body: { value: [] } },
      ],
      { ms: 5, requestId: 'r' },
      { tenantId: 't', tenantName: 'x' },
    );
    expect(ok.errors).toBeUndefined();
    expect(ok.counts).toEqual({ users: 1, groups: 2, apps: 3, devices: 4 });
    expect(ok.provenance.users).toEqual({ service: 'graph', path: '/users/$count', ms: 5, requestId: 'r' });
  });
});
