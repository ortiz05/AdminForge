import { CreatorAccess, type AutomationGraph } from '@adminforge/api/src/schedules/creator-access';

// Before each run of a report schedule created in the portal, the creator must still be an enabled member (not a guest)
// holding Portal.Operator and the report's roles — read as the automation identity from the Read app's role
// assignments and the creator's (transitive) group memberships.

const READ_APP = '11111111-1111-4111-8111-111111111111';
const SP = '22222222-2222-4222-8222-222222222222';
const ROLE = {
  'Portal.Reader': 'aaaaaaaa-0000-4000-8000-000000000001',
  'Portal.Operator': 'aaaaaaaa-0000-4000-8000-000000000002',
  'Portal.Admin': 'aaaaaaaa-0000-4000-8000-000000000005',
};
const GROUP = {
  reader: 'bbbbbbbb-0000-4000-8000-000000000001',
  operator: 'bbbbbbbb-0000-4000-8000-000000000002',
  admin: 'bbbbbbbb-0000-4000-8000-000000000005',
};
const AVERY = '00000000-0000-4000-8000-0000000000a1';
const DIRECT = '00000000-0000-4000-8000-0000000000d1';

class FakeGraph implements AutomationGraph {
  calls: string[] = [];
  users: Record<string, { accountEnabled: boolean; userType: string } | null> = {
    [AVERY]: { accountEnabled: true, userType: 'Member' },
    [DIRECT]: { accountEnabled: true, userType: 'Member' },
  };
  /** Groups each user is a (transitive) member of. */
  memberOf: Record<string, string[]> = { [AVERY]: [GROUP.reader, GROUP.operator] };
  extraGroups: string[] = [];
  fail: RegExp | null = null;

  async get(path: string) {
    this.calls.push(`GET ${path}`);
    if (this.fail?.test(path)) throw new Error('Graph answered 403');
    if (path === `/servicePrincipals(appId='${READ_APP}')`)
      return { id: SP, appRoles: Object.entries(ROLE).map(([value, id]) => ({ id, value })) };
    if (path === `/servicePrincipals/${SP}/appRoleAssignedTo`)
      return {
        value: [
          { principalId: GROUP.reader, principalType: 'Group', appRoleId: ROLE['Portal.Reader'] },
          { principalId: GROUP.operator, principalType: 'Group', appRoleId: ROLE['Portal.Operator'] },
          { principalId: GROUP.admin, principalType: 'Group', appRoleId: ROLE['Portal.Admin'] },
          { principalId: DIRECT, principalType: 'User', appRoleId: ROLE['Portal.Operator'] },
          ...this.extraGroups.map((g) => ({
            principalId: g,
            principalType: 'Group',
            appRoleId: ROLE['Portal.Reader'],
          })),
        ],
      };
    const user = /^\/users\/([0-9a-f-]+)$/.exec(path);
    if (user) return this.users[user[1]!] ?? null;
    throw new Error(`unexpected GET ${path}`);
  }

  async post(path: string, body: unknown) {
    this.calls.push(`POST ${path}`);
    if (this.fail?.test(path)) throw new Error('Graph answered 503');
    const user = /^\/users\/([0-9a-f-]+)\/checkMemberObjects$/.exec(path);
    if (!user) throw new Error(`unexpected POST ${path}`);
    const ids = (body as { ids: string[] }).ids;
    expect(ids.length).toBeLessThanOrEqual(20);
    return { value: ids.filter((g) => (this.memberOf[user[1]!] ?? []).includes(g)) };
  }
}

function setup(o: { readClientId?: string | null } = {}) {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const graph = new FakeGraph();
  const access = new CreatorAccess({
    graph,
    readClientId: o.readClientId === undefined ? READ_APP : o.readClientId,
    now: () => new Date(now),
  });
  return { graph, access, advance: (ms: number) => (now += ms) };
}

describe('CreatorAccess', () => {
  it('ok when the creator holds every role through group membership (transitive)', async () => {
    const { access, graph } = setup();
    expect(await access.check(AVERY, ['Portal.Operator', 'Portal.Reader'])).toEqual({ status: 'ok' });
    expect(graph.calls).toEqual([
      `GET /servicePrincipals(appId='${READ_APP}')`,
      `GET /servicePrincipals/${SP}/appRoleAssignedTo`,
      `GET /users/${AVERY}`,
      `POST /users/${AVERY}/checkMemberObjects`,
    ]);
  });

  it('ok for a direct user assignment', async () => {
    const { access } = setup();
    expect(await access.check(DIRECT, ['Portal.Operator'])).toEqual({ status: 'ok' });
  });

  it('removed when a role is missing, and says which', async () => {
    const { access } = setup();
    expect(await access.check(AVERY, ['Portal.Operator', 'Portal.Admin'])).toEqual({
      status: 'removed',
      reason: 'missing_role',
      missing: ['Portal.Admin'],
    });
  });

  it('removed when the account was deleted, disabled or is now a guest', async () => {
    const { access, graph } = setup();
    graph.users[AVERY] = null;
    expect(await access.check(AVERY, ['Portal.Operator'])).toEqual({
      status: 'removed',
      reason: 'not_found',
    });
    access.invalidate();
    graph.users[AVERY] = { accountEnabled: false, userType: 'Member' };
    expect(await access.check(AVERY, ['Portal.Operator'])).toEqual({ status: 'removed', reason: 'disabled' });
    access.invalidate();
    graph.users[AVERY] = { accountEnabled: true, userType: 'Guest' };
    expect(await access.check(AVERY, ['Portal.Operator'])).toEqual({ status: 'removed', reason: 'guest' });
  });

  it('unverified (not removed) when Graph can’t be read or the Read app isn’t configured', async () => {
    const failing = setup();
    failing.graph.fail = /checkMemberObjects/;
    expect(await failing.access.check(AVERY, ['Portal.Operator'])).toMatchObject({ status: 'unverified' });
    const noRoles = setup();
    noRoles.graph.fail = /appRoleAssignedTo/;
    expect(await noRoles.access.check(AVERY, ['Portal.Operator'])).toMatchObject({ status: 'unverified' });
    // Failures aren't cached: once Graph answers, the check goes through.
    failing.graph.fail = null;
    expect(await failing.access.check(AVERY, ['Portal.Operator'])).toEqual({ status: 'ok' });
    const unconfigured = setup({ readClientId: null });
    expect(await unconfigured.access.check(AVERY, ['Portal.Operator'])).toMatchObject({
      status: 'unverified',
      problem: expect.stringContaining('AF_READ_CLIENT_ID'),
    });
    expect(await setup().access.check('not-a-guid', ['Portal.Operator'])).toMatchObject({
      status: 'unverified',
    });
  });

  it('caches answers for 10 minutes, then asks again', async () => {
    const { access, graph, advance } = setup();
    await access.check(AVERY, ['Portal.Operator']);
    const asked = graph.calls.length;
    advance(9 * 60_000);
    await access.check(AVERY, ['Portal.Reader']);
    expect(graph.calls.length).toBe(asked);
    // Access removed meanwhile: noticed once the cache expires.
    graph.memberOf[AVERY] = [GROUP.reader];
    advance(2 * 60_000);
    expect(await access.check(AVERY, ['Portal.Operator'])).toMatchObject({
      status: 'removed',
      missing: ['Portal.Operator'],
    });
    expect(graph.calls.length).toBeGreaterThan(asked);
  });

  it('checks group membership in chunks of 20', async () => {
    const { access, graph } = setup();
    graph.extraGroups = Array.from(
      { length: 30 },
      (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(await access.check(AVERY, ['Portal.Operator'])).toEqual({ status: 'ok' });
    expect(graph.calls.filter((c) => c.endsWith('checkMemberObjects'))).toHaveLength(2);
  });
});
