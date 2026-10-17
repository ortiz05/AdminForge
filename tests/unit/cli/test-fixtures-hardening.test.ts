import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
} from '@adminforge/cli/src/commands/provision';
import { removeTestFixtures } from '@adminforge/cli/src/commands/test-fixtures';
import { RESOURCES } from '@adminforge/cli/src/provision/catalog';
import { GROUP_TARGET } from '@adminforge/cli/src/provision/fixtures-model';
import { createFixturesCloud, type FixturesCloudOptions } from './fixtures-fake';

// Hardening of the licensed test fixtures (security review): the provisioner's standing fixture permissions are
// flagged; a leftover approver is ✗ and removable without the opt-in, in any label, and leaves no campaign exclusion
// behind; the approver is refused where automation writes are allowed and its roles through groups are seen; Intune
// assignments are exactly "include AF-Test-Group-01"; strangers in that group are flagged.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const SKU = randomUUID();

function setup(extra: Record<string, string> = {}, cloudOpts: Partial<FixturesCloudOptions> = {}) {
  const cloud = createFixturesCloud({
    tenantId: TENANT,
    provisioner: PROVISIONER,
    skus: [{ skuId: SKU, skuPartNumber: 'SPE_E5' }],
    ...cloudOpts,
  });
  const env: Record<string, string | undefined> = {
    AF_TENANT_ID: TENANT,
    AF_PROVISIONER_CLIENT_ID: PROVISIONER.clientId,
    AF_PROVISIONER_CLIENT_SECRET: PROVISIONER.secret,
    AF_SUBSCRIPTION_ID: randomUUID(),
    AF_PRIMARY_DOMAIN: 'example.com',
    AF_ENV_LABEL: 'test',
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

const approverOf = (cloud: ReturnType<typeof createFixturesCloud>) =>
  cloud.users.find((u) => u.userPrincipalName === 'af-approver@example.com');
const excluded = (cloud: ReturnType<typeof createFixturesCloud>) =>
  (
    cloud.authMethodsPolicy.registrationEnforcement.authenticationMethodsRegistrationCampaign
      .excludeTargets as Array<{
      id: string;
    }>
  ).map((t) => t.id);

/** Gives the provisioner's app-only token these Graph application permissions. */
function grantProvisioner(cloud: ReturnType<typeof createFixturesCloud>, permissions: string[]) {
  const graph = cloud.sps.find((s) => s.appId === RESOURCES.graph.appId)!;
  const sp = { id: randomUUID(), appId: PROVISIONER.clientId, displayName: 'Provisioner' };
  cloud.sps.push(sp);
  for (const value of permissions) {
    const role = { id: randomUUID(), value, allowedMemberTypes: ['Application'], isEnabled: true };
    (graph.appRoles as unknown[]).push(role);
    cloud.assignments.push({
      id: randomUUID(),
      principalId: sp.id,
      resourceId: graph.id,
      appRoleId: role.id,
    });
  }
}

describe('the provisioner’s standing fixture permissions', () => {
  it('are a ⚠ in `provision status` (names only), not a failure', async () => {
    const { cloud, ctx, lines } = setup();
    await provisionEntra(ctx);
    grantProvisioner(cloud, ['LicenseAssignment.ReadWrite.All', 'Team.Create', 'User.Read.All']);
    const status = await provisionStatus(ctx);
    const line = lines.find((l) => l.includes('Provisioner holds'))!;
    expect(line).toMatch(
      /⚠ Provisioner holds Microsoft Graph application permissions used only for test fixtures: LicenseAssignment\.ReadWrite\.All, Team\.Create — .*remove them between provisioning runs/,
    );
    expect(line).not.toContain('User.Read.All');
    expect(status.failures.some((f) => /Provisioner holds/.test(f))).toBe(false);
  });

  it('none held: ✓', async () => {
    const { ctx, lines } = setup();
    await provisionEntra(ctx);
    await provisionStatus(ctx);
    expect(lines).toContain('    ✓ Provisioner holds no test-fixture application permissions between runs');
  });
});

describe('a leftover approver', () => {
  it('is ✗ in status once the fixture is opted out, and --remove-fixtures deletes it without the opt-in', async () => {
    const { cloud, ctx, env, lines } = setup({ AF_TEST_FIXTURES: 'approver' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const approver = approverOf(cloud)!;
    expect(excluded(cloud)).toContain(approver.id);

    delete env.AF_TEST_FIXTURES;
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(lines.join('\n')).toMatch(
      /✗ AF Tester 2 \(AF_TEST_APPROVER_UPN\) — left over: .*--remove-fixtures/,
    );

    const before = cloud.calls.length;
    await removeTestFixtures(ctx);
    expect(approverOf(cloud)).toBeUndefined();
    // Out of the registration campaign's exclusions first, then deleted.
    expect(excluded(cloud)).not.toContain(approver.id);
    const writes = cloud.calls.slice(before).filter((c) => !c.startsWith('GET ') && !c.includes('/token'));
    expect(writes.findIndex((c) => c.includes('authenticationMethodsPolicy'))).toBeLessThan(
      writes.findIndex((c) => c.startsWith('DELETE') && c.includes(String(approver.id))),
    );
  });

  it('--remove-fixtures works in a label that is not a test environment (it removes only marked objects)', async () => {
    const { cloud, ctx, env } = setup({ AF_TEST_FIXTURES: 'approver,named-location' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    env.AF_ENV_LABEL = 'prod';
    env.AF_TEST_IDENTITY_LABELS = 'test';
    await removeTestFixtures(ctx);
    expect(approverOf(cloud)).toBeUndefined();
    expect(cloud.namedLocations).toEqual([]);
  });

  it('is ✗ in status in a non-test environment', async () => {
    const { ctx, env, lines } = setup({ AF_TEST_FIXTURES: 'approver' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    env.AF_TEST_IDENTITY_LABELS = 'staging';
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(lines.join('\n')).toMatch(
      /✗ The approver test account \(AF Tester 2\) is left over in a non-test environment/,
    );
    expect(status.ok).toBe(false);
  });
});

describe('the approver', () => {
  it('becomes ✗ in status when AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true is turned on for the label', async () => {
    const { ctx, env, lines } = setup({ AF_TEST_FIXTURES: 'approver' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    env.AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS = 'true';
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(lines.join('\n')).toMatch(
      /✗ AF Tester 2 \(AF_TEST_APPROVER_UPN\) — refused: AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true/,
    );
  });

  it('a directory role it holds through a group is ✗ (read transitively, like the validation user’s)', async () => {
    const { cloud, ctx, lines } = setup({ AF_TEST_FIXTURES: 'approver' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const group = { id: randomUUID(), displayName: 'Helpdesk', isAssignableToRole: true };
    cloud.groups.push(group);
    cloud.members.push({ groupId: group.id, memberId: String(approverOf(cloud)!.id) });
    cloud.roleAssignments.push({
      id: randomUUID(),
      principalId: group.id,
      roleDefinitionId: 'fe930be7-5e62-47db-91af-98c3a49a38b1', // User Administrator
      directoryScopeId: '/',
    });
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(lines.join('\n')).toMatch(/✗ AF Tester 2: User Administrator through a group/);
    expect(status.ok).toBe(false);
  });
});

describe('Intune assignments', () => {
  it('another target next to AF-Test-Group-01 is ✗, and the next run assigns AF-Test-Group-01 only', async () => {
    const { cloud, ctx, lines } = setup({ AF_TEST_FIXTURES: 'intune' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    const policy = String(cloud.intune.deviceCompliancePolicies[0]!.id);
    cloud.policyAssignments.set(policy, [
      { '@odata.type': GROUP_TARGET, groupId: group.id },
      { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' },
    ]);
    lines.length = 0;
    expect((await provisionStatus(ctx)).ok).toBe(false);
    expect(lines.join('\n')).toMatch(
      /✗ AF-Test Compliance \(Windows\) \(compliance policy\) → AF-Test-Group-01 — assigned to 2 other target\(s\)/,
    );
    await provisionTestIdentities(ctx);
    expect(cloud.policyAssignments.get(policy)).toEqual([{ '@odata.type': GROUP_TARGET, groupId: group.id }]);
  });

  it('members of AF-Test-Group-01 that are not provisioning’s test accounts or AF-Test-* devices are a ⚠ (a count)', async () => {
    const { cloud, ctx, lines } = setup({ AF_TEST_FIXTURES: 'intune' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    cloud.addMember(group.id, {
      id: randomUUID(),
      '@odata.type': '#microsoft.graph.device',
      displayName: 'AF-Test-Win11',
    });
    lines.length = 0;
    await provisionStatus(ctx);
    expect(lines.join('\n')).not.toMatch(/member\(s\) that aren't provisioning's/);
    cloud.addMember(group.id, {
      id: randomUUID(),
      '@odata.type': '#microsoft.graph.device',
      displayName: 'LAPTOP-42',
    });
    const jane = { id: randomUUID(), userPrincipalName: 'jane@example.com', displayName: 'Jane Doe' };
    cloud.users.push(jane);
    cloud.members.push({ groupId: group.id, memberId: jane.id });
    lines.length = 0;
    await provisionStatus(ctx);
    const line = lines.find((l) => l.includes("aren't provisioning's"))!;
    expect(line).toMatch(
      /⚠ AF-Test-Group-01 has 2 member\(s\) .* receive the AF-Test Intune and group-scoped AF-Audit policies/,
    );
    expect(line).not.toMatch(/Jane|LAPTOP/);
  });
});
