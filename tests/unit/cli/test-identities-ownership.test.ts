import { randomUUID } from 'node:crypto';
import { ConfigError, type CliContext } from '@adminforge/cli/src/commands/context';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from '@adminforge/cli/src/commands/provision';
import { DIRECTORY_ROLES } from '@adminforge/cli/src/provision/catalog';
import { applyIdentityOps } from '@adminforge/cli/src/provision/identities-io';
import {
  buildDesiredIdentities,
  isProvisionedTester,
  planIdentities,
  TESTER_MARKER,
  unexpectedTesterRoles,
  type IdentityState,
} from '@adminforge/cli/src/provision/identities-plan';
import { createGraphClient } from '@adminforge/connectors';
import { createFakeCloud, type FakeCloudOptions } from './fake-cloud';

// The validation user is provisioning's own account: an existing account it didn't create is never re-passworded,
// re-roled, excluded from the registration campaign, enabled or disabled. Tenant-wide Exchange / SharePoint admin
// roles are opt-in (AF_TEST_SERVICE_ADMIN_ROLES=true), and `provision status` flags any other directory role.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const LICENSED = ['EXCHANGE_S_ENTERPRISE', 'SHAREPOINTENTERPRISE'];
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const PRIVILEGED_ROLE_ADMIN = 'e8611ab8-c189-46e8-94e1-60213ab1f814';

function setup(extra: Record<string, string> = {}, cloudOpts: Partial<FakeCloudOptions> = {}) {
  const cloud = createFakeCloud({ tenantId: TENANT, provisioner: PROVISIONER, ...cloudOpts });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: 'test',
    ...extra,
  };
  const written: Array<Record<string, string>> = [];
  const lines: string[] = [];
  const ctx: CliContext = {
    env,
    writeEnv: (u) => {
      written.push(u);
      Object.assign(env, u);
    },
    out: (l) => lines.push(l),
    fetch: cloud.fetch,
    sleep: async () => {},
    contentScopes: {},
  };
  return { cloud, env, lines, written, ctx };
}

const testerOf = (cloud: ReturnType<typeof createFakeCloud>) =>
  cloud.users.find((u) => u.userPrincipalName === 'af-tester@example.com')!;
const rolesOf = (cloud: ReturnType<typeof createFakeCloud>, id: unknown) =>
  cloud.roleAssignments.filter((r) => r.principalId === id).map((r) => r.roleDefinitionId);
const writesTo = (cloud: ReturnType<typeof createFakeCloud>, id: unknown) =>
  cloud.calls.filter((c) => !c.startsWith('GET ') && c.includes(String(id)));

describe('who counts as the validation user', () => {
  it('needs an af- UPN and either the marker or the "AF Tester" display name', () => {
    const upn = 'af-tester@example.com';
    expect(isProvisionedTester({ userPrincipalName: upn, displayName: 'AF Tester' })).toBe(true);
    expect(
      isProvisionedTester({ userPrincipalName: upn, displayName: 'Renamed', employeeType: TESTER_MARKER }),
    ).toBe(true);
    expect(isProvisionedTester({ userPrincipalName: upn, displayName: 'Jane Doe' })).toBe(false);
    expect(isProvisionedTester({ userPrincipalName: upn })).toBe(false);
    expect(isProvisionedTester({ userPrincipalName: 'jane@example.com', displayName: 'AF Tester' })).toBe(
      false,
    );
    expect(isProvisionedTester({ userPrincipalName: 'jane@example.com', employeeType: TESTER_MARKER })).toBe(
      false,
    );
  });

  it('creates the validation user with the marker', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(testerOf(cloud)).toMatchObject({ displayName: 'AF Tester', employeeType: TESTER_MARKER });
  });
});

describe('an account provisioning did not create', () => {
  it('is refused before anything changes (also in a dry run): no password, roles, groups or campaign exclusion', async () => {
    const { cloud, ctx, written, lines } = setup();
    await provisionEntra(ctx);
    const foreign = {
      id: randomUUID(),
      userPrincipalName: 'af-tester@example.com',
      displayName: 'Jane Doe',
      accountEnabled: true,
    };
    cloud.users.push(foreign);
    const before = cloud.calls.length;
    await expect(provisionTestIdentities(ctx, { dryRun: true })).rejects.toThrow(ConfigError);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/not created by AdminForge provisioning/);
    const after = cloud.calls.slice(before);
    expect(after.filter((c) => !c.startsWith('GET ') && !c.includes('/oauth2/v2.0/token'))).toEqual([]);
    expect(written).not.toContainEqual(expect.objectContaining({ AF_TEST_USER_PASSWORD: expect.anything() }));
    expect(rolesOf(cloud, foreign.id)).toEqual([]);
    expect(cloud.members.some((m) => m.memberId === foreign.id)).toBe(false);
    expect(cloud.users).toHaveLength(1); // not even the AF-Test-* targets: nothing is applied
    // Its memberships and roles are not even read.
    expect(after.some((c) => c.includes(`/users/${foreign.id}/`))).toBe(false);
    expect(lines.join('\n')).not.toContain(foreign.id);
  });

  it('refuses an AF_TEST_USER_UPN that is not af-…, even when it does not exist yet', async () => {
    const { cloud, ctx } = setup({ AF_TEST_USER_UPN: 'jane@example.com' });
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/must start with "af-"/);
    expect(cloud.calls.some((c) => c === 'POST graph.microsoft.com/v1.0/users')).toBe(false);
  });

  it('is neither enabled nor disabled', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    const foreign = { id: randomUUID(), userPrincipalName: 'af-tester@example.com', accountEnabled: true };
    cloud.users.push(foreign);
    await expect(setTesterEnabled(ctx, false)).rejects.toThrow(ConfigError);
    await expect(setTesterEnabled(ctx, true)).rejects.toThrow(ConfigError);
    expect(foreign.accountEnabled).toBe(true);
    expect(cloud.revoked).toEqual([]);
  });

  it('a stale read that misses it never leads to a password reset', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    const foreign = { id: randomUUID(), userPrincipalName: 'af-tester@example.com', displayName: 'Jane Doe' };
    cloud.users.push(foreign);
    const desired = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
    // The plan was made from a read that didn't see the account yet: it plans a create.
    const state: IdentityState = {
      testerGroupIds: [],
      testerRoleIds: [],
      portalGroups: {},
      targets: {},
      env: {},
    };
    const ops = planIdentities(desired, state).filter((o) => o.kind === 'tester');
    expect(ops).toMatchObject([{ mode: 'create' }]);
    const graph = createGraphClient({ getToken: async () => 'token', fetch: cloud.fetch });
    await expect(
      applyIdentityOps(ops, state, { graph, writeEnv: () => undefined, log: () => undefined }),
    ).rejects.toThrow(/not created by AdminForge provisioning/);
    expect(writesTo(cloud, foreign.id)).toEqual([]);
    expect(foreign).not.toHaveProperty('passwordProfile');
  });

  it('provision status fails on it without reading its roles', async () => {
    const { cloud, ctx, lines } = setup();
    await provisionEntra(ctx);
    cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-tester@example.com',
      displayName: 'Jane Doe',
    });
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.failures).toContain('AF Tester (AF_TEST_USER_UPN): not an account provisioning created');
    const output = lines.join('\n');
    expect(output).not.toContain('Validation user: unexpected privilege');
    // A failure, not something licensing withholds.
    expect(output.split('Not provisioned here').at(-1)).not.toContain('AF_TEST_USER_UPN');
  });
});

describe('Exchange / SharePoint service admin roles are opt-in (AF_TEST_SERVICE_ADMIN_ROLES)', () => {
  const service = [
    DIRECTORY_ROLES['Exchange Recipient Administrator'],
    DIRECTORY_ROLES['SharePoint Administrator'],
  ];

  it('off by default in a licensed tenant: withheld, listed under the permission ceiling, and removed if held', async () => {
    const { cloud, ctx, lines } = setup({}, { servicePlans: LICENSED });
    await provisionEntra(ctx);
    const run = await provisionTestIdentities(ctx);
    const t = testerOf(cloud);
    expect(rolesOf(cloud, t.id)).toEqual([
      DIRECTORY_ROLES['User Administrator'],
      DIRECTORY_ROLES['Global Reader'],
    ]);
    expect(run.ops.filter((o) => o.action === 'skip').map((o) => o.title)).toEqual(
      expect.arrayContaining([
        'AF Tester: Exchange Recipient Administrator (directory scope /)',
        'AF Tester: SharePoint Administrator (directory scope /)',
      ]),
    );
    const output = lines.join('\n');
    expect(output).toContain('Withheld by a permission ceiling');
    expect(output).toContain('set AF_TEST_SERVICE_ADMIN_ROLES=true');

    // Held from an earlier run: re-provisioning without the opt-in removes them.
    for (const roleDefinitionId of service)
      cloud.roleAssignments.push({
        id: randomUUID(),
        principalId: t.id,
        roleDefinitionId,
        directoryScopeId: '/',
      });
    const again = await provisionTestIdentities(ctx);
    expect(again.ops.filter((o) => o.action === 'delete')).toHaveLength(2);
    expect(rolesOf(cloud, t.id)).not.toEqual(expect.arrayContaining([service[0]]));
    expect(rolesOf(cloud, t.id)).not.toEqual(expect.arrayContaining([service[1]]));
  });

  it('with AF_TEST_SERVICE_ADMIN_ROLES=true in a licensed tenant they are assigned', async () => {
    const { cloud, ctx } = setup({ AF_TEST_SERVICE_ADMIN_ROLES: 'true' }, { servicePlans: LICENSED });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(rolesOf(cloud, testerOf(cloud).id)).toEqual(expect.arrayContaining(service));
    expect((await provisionStatus(ctx)).failures).toEqual([]);
  });

  it('the opt-in grants nothing in an unlicensed tenant', async () => {
    const { cloud, ctx } = setup({ AF_TEST_SERVICE_ADMIN_ROLES: 'true' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(rolesOf(cloud, testerOf(cloud).id)).toHaveLength(2);
  });
});

describe('provision status: other directory roles of the validation user are unexpected privilege', () => {
  async function provisioned(cloudOpts: Partial<FakeCloudOptions> = {}) {
    const s = setup({}, cloudOpts);
    await provisionEntra(s.ctx);
    await provisionTestIdentities(s.ctx);
    s.lines.length = 0;
    return { ...s, tester: testerOf(s.cloud) };
  }

  it('✓ when it holds only what provisioning manages', async () => {
    const { ctx, lines } = await provisioned();
    expect((await provisionStatus(ctx)).failures).toEqual([]);
    expect(lines.join('\n')).toContain('✓ No directory roles beyond the ones provisioning manages');
  });

  it('a role outside the catalogue, a scoped role and a role through a group each fail, by name only', async () => {
    const { cloud, ctx, lines, tester } = await provisioned();
    const au = randomUUID();
    const group = { id: randomUUID(), displayName: 'Role-assignable admins' };
    cloud.groups.push(group);
    cloud.members.push({ groupId: group.id, memberId: tester.id as string });
    cloud.roleAssignments.push(
      { id: randomUUID(), principalId: tester.id, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/' },
      {
        id: randomUUID(),
        principalId: tester.id,
        roleDefinitionId: DIRECTORY_ROLES['Groups Administrator'],
        directoryScopeId: `/administrativeUnits/${au}`,
      },
      {
        id: randomUUID(),
        principalId: group.id,
        roleDefinitionId: PRIVILEGED_ROLE_ADMIN,
        directoryScopeId: '/',
      },
    );
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(status.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AF Tester holds Global Administrator \(directory scope \/\) — not granted/),
        expect.stringMatching(/^AF Tester holds Groups Administrator \(an administrative unit\)/),
        expect.stringMatching(
          /^AF Tester holds Privileged Role Administrator \(directory scope \/, through a group\)/,
        ),
      ]),
    );
    const output = lines.join('\n');
    for (const id of [au, group.id, tester.id as string, GLOBAL_ADMIN]) expect(output).not.toContain(id);
  });

  it('⚠ (not a failure) when the roles held through groups cannot be read', async () => {
    const { ctx, lines } = await provisioned({ directoryRolesReadable: false });
    const status = await provisionStatus(ctx);
    expect(status.failures).toEqual([]);
    expect(lines.join('\n')).toMatch(
      /⚠ Directory roles — the validation user's directory roles held through groups could not be read \(403/,
    );
  });

  it('is pure over the fetched state', () => {
    const state: IdentityState = {
      tester: { id: 't', userPrincipalName: 'af-tester@example.com', displayName: 'AF Tester' },
      testerGroupIds: [],
      testerRoleIds: [],
      portalGroups: {},
      targets: {},
      env: {},
      testerRoleGrants: [
        { roleDefinitionId: DIRECTORY_ROLES['Global Reader'], scope: '/', via: 'direct' },
        { roleDefinitionId: randomUUID(), scope: '/', via: 'direct' },
      ],
    };
    expect(unexpectedTesterRoles(state).lines).toEqual([
      'AF Tester holds a directory role whose name could not be read (directory scope /) — not granted by provisioning; remove it in the Entra admin centre',
    ]);
  });
});
