import { randomUUID } from 'node:crypto';
import { ConfigError, type CliContext } from '@adminforge/cli/src/commands/context';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from '@adminforge/cli/src/commands/provision';
import { DIRECTORY_ROLES } from '@adminforge/cli/src/provision/catalog';
import {
  buildDesiredIdentities,
  planIdentities,
  TESTER_DIRECTORY_ROLES,
  TESTER_PORTAL_ROLES,
  type IdentityState,
} from '@adminforge/cli/src/provision/identities-plan';
import { createFakeCloud } from './fake-cloud';

// The validation user gets only what the live suite needs, owns its test group instead of holding Groups
// Administrator, is disabled between runs, and exists only in test environments.
const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };

function setup(label = 'test', extra: Record<string, string> = {}) {
  const cloud = createFakeCloud({ tenantId: TENANT, provisioner: PROVISIONER });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: label,
    ...extra,
  };
  const lines: string[] = [];
  const ctx: CliContext = {
    env,
    writeEnv: (u) => Object.assign(env, u),
    out: (l) => lines.push(l),
    fetch: cloud.fetch,
    sleep: async () => {},
    contentScopes: {},
  };
  return { cloud, env, lines, ctx };
}

const tester = (cloud: ReturnType<typeof createFakeCloud>) =>
  cloud.users.find((u) => u.userPrincipalName === 'af-tester@example.com')!;

describe('validation user: least privilege', () => {
  it('needs Reader, Operator and Admin, Global Reader and User Administrator — not Approver or Groups Administrator', () => {
    const d = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
    expect(d.testerGroups).toEqual(['Portal.Reader', 'Portal.Operator', 'Portal.Admin']);
    expect(d.testerRoles).toEqual(['User Administrator', 'Global Reader']);
    expect(TESTER_PORTAL_ROLES).not.toContain('Playbook.Approver');
    expect(TESTER_DIRECTORY_ROLES).not.toContain('Groups Administrator');
  });

  it('plans removal of roles and memberships earlier versions granted, and ownership of AF-Test-Group-01', () => {
    const d = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
    const groups = Object.fromEntries(
      ['Portal.Reader', 'Portal.Operator', 'Playbook.Author', 'Playbook.Approver', 'Portal.Admin'].map(
        (r) => [r, { id: randomUUID(), displayName: r }],
      ),
    );
    const testerId = randomUUID();
    const state: IdentityState = {
      tester: {
        id: testerId,
        userPrincipalName: d.tester.upn,
        displayName: 'AF Tester',
        accountEnabled: true,
      },
      testerGroupIds: Object.values(groups).map((g) => g.id),
      testerRoleIds: [],
      testerRoleAssignments: Object.values(DIRECTORY_ROLES).map((roleDefinitionId) => ({
        id: randomUUID(),
        roleDefinitionId,
      })),
      portalGroups: groups,
      targets: Object.fromEntries(
        d.targets.map((t) => [t.upn, { id: randomUUID(), userPrincipalName: t.upn }]),
      ),
      testGroup: { id: randomUUID(), displayName: 'AF-Test-Group-01' },
      testGroupOwnerIds: [],
      env: { upn: d.tester.upn, password: 'stored' },
    };
    const changes = planIdentities(d, state).filter((o) => o.action !== 'noop');
    expect(changes.map((o) => `${o.action} ${o.title}`)).toEqual([
      'delete AF Tester ∉ SG-AdminForge-test-Playbook.Author',
      'delete AF Tester ∉ SG-AdminForge-test-Playbook.Approver',
      'delete AF Tester: Groups Administrator (directory scope /)',
      // Service write roles are kept only where the tenant licenses the workload (not in this unlicensed plan).
      'delete AF Tester: Exchange Recipient Administrator (directory scope /)',
      'delete AF Tester: SharePoint Administrator (directory scope /)',
      'create AF Tester owns AF-Test-Group-01',
    ]);
    const remove = changes.find((o) => o.kind === 'directoryRoleRemove');
    expect(remove && 'assignmentIds' in remove && remove.assignmentIds).toHaveLength(1);
  });

  it('applies against Graph: tester created disabled, owner of the test group, Groups Administrator removed', async () => {
    const { cloud, ctx } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const t = tester(cloud);
    expect(t.accountEnabled).toBe(false);
    const group = cloud.groups.find((g) => g.displayName === 'AF-Test-Group-01')!;
    expect(cloud.owners.get(group.id)).toEqual([t.id]);
    expect(
      cloud.roleAssignments.filter((r) => r.principalId === t.id).map((r) => r.roleDefinitionId),
    ).toEqual([DIRECTORY_ROLES['User Administrator'], DIRECTORY_ROLES['Global Reader']]);

    // An installation provisioned by an earlier version: Groups Administrator and the Approver group are removed.
    cloud.roleAssignments.push({
      id: randomUUID(),
      principalId: t.id,
      roleDefinitionId: DIRECTORY_ROLES['Groups Administrator'],
      directoryScopeId: '/',
    });
    const approver = cloud.groups.find((g) => g.displayName === 'SG-AdminForge-test-Playbook.Approver')!;
    cloud.members.push({ groupId: approver.id, memberId: t.id as string });
    expect((await provisionStatus(ctx)).failures).toEqual(
      expect.arrayContaining([
        'AF Tester: Groups Administrator (directory scope /)',
        'AF Tester ∉ SG-AdminForge-test-Playbook.Approver',
      ]),
    );
    const run = await provisionTestIdentities(ctx);
    expect(run.ops.filter((o) => o.action === 'delete')).toHaveLength(2);
    expect(
      cloud.roleAssignments.some((r) => r.roleDefinitionId === DIRECTORY_ROLES['Groups Administrator']),
    ).toBe(false);
    expect(cloud.members.some((m) => m.groupId === approver.id)).toBe(false);
    expect(
      (await provisionTestIdentities(ctx)).ops.every((o) => o.action === 'noop' || o.action === 'skip'),
    ).toBe(true);
  });
});

describe('provision test-identities --enable / --disable', () => {
  it('toggles sign-in idempotently, revokes sessions on disable, and prints no identifiers', async () => {
    const { cloud, ctx, lines, env } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    lines.length = 0;
    expect(await setTesterEnabled(ctx, true)).toEqual({ changed: true });
    expect(tester(cloud).accountEnabled).toBe(true);
    expect(await setTesterEnabled(ctx, true)).toEqual({ changed: false });
    expect(await setTesterEnabled(ctx, false)).toEqual({ changed: true });
    expect(tester(cloud).accountEnabled).toBe(false);
    expect(cloud.revoked).toEqual([tester(cloud).id]);
    expect(await setTesterEnabled(ctx, false)).toEqual({ changed: false });
    const output = lines.join('\n');
    expect(output).toContain('Validation user (AF_TEST_USER_UPN): already disabled.');
    for (const v of [env.AF_TEST_USER_UPN!, tester(cloud).id as string, 'example.com'])
      expect(output).not.toContain(v);
  });

  it('refuses to enable outside a test environment, but always allows disabling', async () => {
    const { cloud, ctx } = setup('prod');
    await provisionEntra(ctx);
    cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-tester@example.com',
      displayName: 'AF Tester',
      accountEnabled: true,
    });
    await expect(setTesterEnabled(ctx, true)).rejects.toThrow(ConfigError);
    expect(await setTesterEnabled(ctx, false)).toEqual({ changed: true });
  });
});

describe('test identities only in test environments (AF_TEST_IDENTITY_LABELS)', () => {
  it('refuses to provision them for a label that is not listed', async () => {
    const { ctx, cloud } = setup('prod');
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(/AF_TEST_IDENTITY_LABELS/);
    expect(cloud.users).toEqual([]);
  });

  it('honours a custom list', async () => {
    const { ctx } = setup('qa', { AF_TEST_IDENTITY_LABELS: 'qa, staging' });
    await provisionEntra(ctx);
    expect((await provisionTestIdentities(ctx)).ops.length).toBeGreaterThan(5);
  });

  it('status passes in a non-test environment without them and fails when they exist', async () => {
    const { ctx, cloud, lines } = setup('prod');
    await provisionEntra(ctx);
    let status = await provisionStatus(ctx);
    expect(status.failures.filter((f) => /non-test/.test(f))).toEqual([]);
    expect(lines.join('\n')).toContain('No test identities (environment "prod" is not a test environment)');
    cloud.users.push({ id: randomUUID(), userPrincipalName: 'af-test-user-01@example.com' });
    status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(status.failures).toContain(
      'Test identities in a non-test environment (AF_ENV_LABEL is not in AF_TEST_IDENTITY_LABELS)',
    );
  });
});
