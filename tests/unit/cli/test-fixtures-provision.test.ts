import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from '@adminforge/cli/src/commands/provision';
import { removeTestFixtures } from '@adminforge/cli/src/commands/test-fixtures';
import { FIXTURE_ROLES, GROUP_TARGET, NAMED_LOCATION } from '@adminforge/cli/src/provision/fixtures-model';
import { APPROVER_MARKER, TESTER_MARKER } from '@adminforge/cli/src/provision/identities-plan';
import { createFixturesCloud, type FixturesCloudOptions } from './fixtures-fake';

// `provision test-identities` with the opt-in licensed test fixtures, against the fake cloud: nothing changes without
// the opt-in; with it, licences, PIM eligibility, the named location, the Intune policies and the approver account
// are provisioned after the test identities, shown in `provision status`, removed by `--remove-fixtures`; a fixture
// Graph refuses prints ✗ with the permission it needs and the others go on. Passwords never reach the output.

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const SKU = randomUUID();
const ALL = { AF_TEST_LICENCE_SKU: 'SPE_E5', AF_TEST_FIXTURES: 'pim,named-location,intune,approver' };

function setup(extra: Record<string, string> = {}, cloudOpts: Partial<FixturesCloudOptions> = {}) {
  const cloud = createFixturesCloud({
    tenantId: TENANT,
    provisioner: PROVISIONER,
    skus: [{ skuId: SKU, skuPartNumber: 'SPE_E5', consumedUnits: 1, enabled: 25 }],
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

const byUpn = (cloud: ReturnType<typeof createFixturesCloud>, upn: string) =>
  cloud.users.find((u) => String(u.userPrincipalName).toLowerCase() === upn);
const licensed = (cloud: ReturnType<typeof createFixturesCloud>) =>
  cloud.users
    .filter((u) =>
      ((u.assignedLicenses as Array<{ skuId: string }> | undefined) ?? []).some((l) => l.skuId === SKU),
    )
    .map((u) => u.displayName)
    .sort();
const FIXTURE_CALL = /assignLicense|roleEligibility|namedLocations|deviceManagement|\/organization/;

describe('without the opt-in', () => {
  it('plans, applies and reads nothing beyond the test identities', async () => {
    const { cloud, ctx, lines } = setup();
    await provisionEntra(ctx);
    const before = cloud.calls.length;
    const run = await provisionTestIdentities(ctx);
    expect(run.fixtureOps).toEqual([]);
    expect(cloud.calls.slice(before).filter((c) => FIXTURE_CALL.test(c))).toEqual([]);
    expect(cloud.users.some((u) => u.displayName === 'AF Tester 2')).toBe(false);
    expect(lines.join('\n')).not.toMatch(/Test fixtures/);
  });
});

describe('with every fixture opted in', () => {
  it('provisions them after the test identities, then has nothing to do', async () => {
    const { cloud, ctx, lines, written } = setup(ALL);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);

    // Licences: the validation user and AF-Test-User-01..03, usage location from the organisation's country.
    expect(licensed(cloud)).toEqual(['AF Tester', 'AF-Test-User-01', 'AF-Test-User-02', 'AF-Test-User-03']);
    expect(byUpn(cloud, 'af-test-user-01@example.com')?.usageLocation).toBe('US');
    expect(cloud.skus[0]!.consumedUnits).toBe(5);
    // PIM: eligible (never active) at directory scope /.
    const tester = byUpn(cloud, 'af-tester@example.com')!;
    const target = byUpn(cloud, 'af-test-user-01@example.com')!;
    expect(cloud.eligibility.map((e) => [e.principalId, e.roleDefinitionId, e.directoryScopeId])).toEqual([
      [target.id, FIXTURE_ROLES['Reports Reader'], '/'],
      [tester.id, FIXTURE_ROLES['Message Center Reader'], '/'],
    ]);
    expect(cloud.eligibility.every((e) => e.expiration.type === 'noExpiration')).toBe(true);
    expect(
      cloud.roleAssignments.some((r) => Object.values(FIXTURE_ROLES).includes(r.roleDefinitionId as never)),
    ).toBe(false);
    // Named location: documentation range, not trusted.
    expect(cloud.namedLocations).toEqual([
      expect.objectContaining({
        displayName: NAMED_LOCATION.displayName,
        isTrusted: false,
        ipRanges: [expect.objectContaining({ cidrAddress: '192.0.2.0/24' })],
      }),
    ]);
    // Intune: both policies, marked, assigned to AF-Test-Group-01 only.
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    for (const list of [cloud.intune.deviceCompliancePolicies, cloud.intune.deviceConfigurations]) {
      expect(list).toHaveLength(1);
      expect(String(list[0]!.description)).toContain(TESTER_MARKER);
      expect(cloud.policyAssignments.get(String(list[0]!.id))).toEqual([
        { '@odata.type': GROUP_TARGET, groupId: group.id },
      ]);
    }
    // Approver: created disabled with its own marker, Portal.Reader and Playbook.Approver only, no directory roles,
    // campaign excluded.
    const approver = byUpn(cloud, 'af-approver@example.com')!;
    expect(approver).toMatchObject({
      displayName: 'AF Tester 2',
      accountEnabled: false,
      employeeType: APPROVER_MARKER,
    });
    const groupsOf = cloud.members
      .filter((m) => m.memberId === approver.id)
      .map((m) => cloud.groups.find((g) => g.id === m.groupId)?.displayName);
    expect(groupsOf).toEqual(['SG-AdminForge-test-Portal.Reader', 'SG-AdminForge-test-Playbook.Approver']);
    expect(cloud.roleAssignments.some((r) => r.principalId === approver.id)).toBe(false);
    expect(
      (
        cloud.authMethodsPolicy.registrationEnforcement.authenticationMethodsRegistrationCampaign
          .excludeTargets as Array<{ id: string }>
      ).map((t) => t.id),
    ).toContain(approver.id);
    // Its password went to the env file only.
    const creds = written.find((w) => w.AF_TEST_APPROVER_PASSWORD);
    expect(creds).toMatchObject({ AF_TEST_APPROVER_UPN: 'af-approver@example.com' });
    expect(lines.join('\n')).not.toContain(creds!.AF_TEST_APPROVER_PASSWORD);
    expect(lines.join('\n')).not.toContain(PROVISIONER.secret);

    lines.length = 0;
    const again = await provisionTestIdentities(ctx);
    expect(lines).toContain('Nothing to do: everything is already in the desired state.');
    expect(again.fixtureOps.every((o) => o.action === 'noop')).toBe(true);
  });

  it('shows the fixtures in `provision status`, ✓ once provisioned', async () => {
    const { ctx, lines } = setup(ALL);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    lines.length = 0;
    await provisionStatus(ctx);
    const text = lines.join('\n');
    expect(text).toContain('Test fixtures: licences');
    expect(text).toMatch(/✓ SPE_E5: 5 of 25 seats used/);
    expect(text).toMatch(/✓ AF-Test-User-03: SPE_E5/);
    expect(text).toMatch(/✓ AF-Test-User-01 eligible for Reports Reader/);
    expect(text).toMatch(/✓ AF-Test-Location \(192\.0\.2\.0\/24, not trusted\)/);
    expect(text).toMatch(/✓ AF-Test Compliance \(Windows\) \(compliance policy\) → AF-Test-Group-01/);
    expect(text).toMatch(/✓ AF Tester 2 ∈ SG-AdminForge-test-Playbook\.Approver/);
    expect(text).not.toMatch(/✗ .*(SPE_E5|eligible|AF-Test-Location|AF-Test Co|AF Tester 2)/);
  });

  it('falls back to 365 days when the role settings refuse permanent eligibility', async () => {
    const { cloud, ctx, lines } = setup({ AF_TEST_FIXTURES: 'pim' }, { permanentEligibility: false });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    expect(cloud.eligibility).toHaveLength(2);
    expect(
      cloud.eligibility.every(
        (e) => e.expiration.type === 'afterDuration' && e.expiration.duration === 'P365D',
      ),
    ).toBe(true);
    expect(lines.join('\n')).toMatch(/365 days/);
  });
});

describe('a fixture Graph refuses', () => {
  it('prints ✗ with the permission, skips the rest of that fixture, applies the others, and exits 1', async () => {
    const { cloud, ctx, lines } = setup(
      { AF_TEST_LICENCE_SKU: 'SPE_E5', AF_TEST_FIXTURES: 'named-location' },
      { forbid: ['licences'] },
    );
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(
      /1 fixture\(s\) could not be provisioned \(licences\)/,
    );
    const text = lines.join('\n');
    expect(text).toMatch(
      /✗ AF Tester: SPE_E5 — the provisioner may not do this: grant it the Microsoft Graph application permission LicenseAssignment\.ReadWrite\.All/,
    );
    expect(text).toMatch(/– not attempted: AF-Test-User-01: SPE_E5/);
    expect(licensed(cloud)).toEqual([]);
    expect(cloud.namedLocations).toHaveLength(1);
    expect(text).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  });

  it('a refused read shows "✗ cannot" with the permission in the plan, ✗ in status, and fails the apply run', async () => {
    const { ctx, lines } = setup({ AF_TEST_FIXTURES: 'intune,named-location' }, { forbid: ['intune'] });
    await provisionEntra(ctx);
    const dry = await provisionTestIdentities(ctx, { dryRun: true });
    expect(dry.fixtureOps.find((o) => o.fixture === 'intune')).toMatchObject({
      action: 'skip',
      blocked: true,
    });
    expect(lines.join('\n')).toMatch(
      /✗ cannot {2}Intune compliance policy and configuration profile .*DeviceManagementConfiguration\.ReadWrite\.All/,
    );
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(ConfigError);
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(lines.join('\n')).toMatch(
      /✗ Intune compliance policy and configuration profile — the provisioner may not do this/,
    );
    expect(lines.join('\n')).toMatch(/✓ AF-Test-Location/);
  });
});

describe('--remove-fixtures', () => {
  it('plans first (dry run changes nothing), then removes only what the fixtures created', async () => {
    const { cloud, ctx, env, lines } = setup(ALL);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    const usersBefore = cloud.users.length;

    const before = cloud.calls.length;
    await removeTestFixtures(ctx, { dryRun: true });
    expect(cloud.calls.slice(before).filter((c) => !c.startsWith('GET ') && !c.includes('/token'))).toEqual(
      [],
    );
    expect(lines.join('\n')).toMatch(/- remove {2}AF-Test-Location/);

    await removeTestFixtures(ctx);
    expect(licensed(cloud)).toEqual([]);
    expect(cloud.eligibility).toEqual([]);
    expect(cloud.namedLocations).toEqual([]);
    expect(cloud.intune.deviceCompliancePolicies).toEqual([]);
    expect(cloud.intune.deviceConfigurations).toEqual([]);
    expect(byUpn(cloud, 'af-approver@example.com')).toBeUndefined();
    expect(cloud.users).toHaveLength(usersBefore - 1); // the validation user and targets stay
    expect(env.AF_TEST_APPROVER_PASSWORD).toBe('');
  });

  it('says there is nothing to remove when no fixture is opted in', async () => {
    const { ctx, lines } = setup();
    expect(await removeTestFixtures(ctx)).toBeUndefined();
    expect(lines.join('\n')).toMatch(/nothing to remove/);
  });
});

describe('--enable / --disable', () => {
  it('--enable turns on the validation user only; --enable --approver also the approver; --disable both', async () => {
    const { cloud, ctx, lines } = setup(ALL);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    await setTesterEnabled(ctx, true);
    expect(byUpn(cloud, 'af-tester@example.com')?.accountEnabled).toBe(true);
    expect(byUpn(cloud, 'af-approver@example.com')?.accountEnabled).toBe(false);
    expect(lines.join('\n')).not.toMatch(/Approver \(AF_TEST_APPROVER_UPN\)/);
    await setTesterEnabled(ctx, true, { approver: true });
    expect(byUpn(cloud, 'af-approver@example.com')?.accountEnabled).toBe(true);
    expect(lines).toContain('✓ Approver (AF_TEST_APPROVER_UPN): enabled.');
    await setTesterEnabled(ctx, false);
    expect(byUpn(cloud, 'af-approver@example.com')?.accountEnabled).toBe(false);
    expect(byUpn(cloud, 'af-tester@example.com')?.accountEnabled).toBe(false);
    await expect(setTesterEnabled(ctx, false, { approver: true })).rejects.toThrow(
      /--approver goes with --enable only/,
    );
  });

  it('--disable tries both accounts even when one fails, and reports each', async () => {
    const { cloud, ctx, lines } = setup(ALL);
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    await setTesterEnabled(ctx, true, { approver: true });
    // The validation user's account is no longer recognisable as provisioning's: its step is refused.
    Object.assign(byUpn(cloud, 'af-tester@example.com')!, { displayName: 'Renamed', employeeType: null });
    lines.length = 0;
    await expect(setTesterEnabled(ctx, false)).rejects.toThrow(/Not disabled: Validation user/);
    expect(lines.join('\n')).toMatch(
      /✗ Validation user \(AF_TEST_USER_UPN\): The account at AF_TEST_USER_UPN was not created/,
    );
    expect(lines).toContain('✓ Approver (AF_TEST_APPROVER_UPN): disabled, sign-in sessions revoked.');
    expect(byUpn(cloud, 'af-approver@example.com')?.accountEnabled).toBe(false);
  });

  it('never enables the approver where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true', async () => {
    const { ctx } = setup({ ...ALL, AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS: 'true' });
    await provisionEntra(ctx);
    await expect(provisionTestIdentities(ctx)).rejects.toThrow(
      /fixture\(s\) could not be provisioned \(approver\)/,
    );
    await expect(setTesterEnabled(ctx, true, { approver: true })).rejects.toThrow(
      /not enabled where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true/,
    );
  });

  it('touch only an account with the approver marker — never one with the validation user’s', async () => {
    const { cloud, ctx } = setup({ AF_TEST_FIXTURES: 'approver' });
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    Object.assign(byUpn(cloud, 'af-approver@example.com')!, {
      employeeType: TESTER_MARKER,
      accountEnabled: false,
    });
    await expect(setTesterEnabled(ctx, true, { approver: true })).rejects.toThrow(
      /does not carry the approver marker/,
    );
    expect(byUpn(cloud, 'af-approver@example.com')?.accountEnabled).toBe(false);
  });

  it('leave the approver alone without the fixture or AF_TEST_APPROVER_UPN', async () => {
    const { ctx, lines } = setup();
    await provisionEntra(ctx);
    await provisionTestIdentities(ctx);
    lines.length = 0;
    await setTesterEnabled(ctx, true);
    await setTesterEnabled(ctx, false);
    expect(lines.join('\n')).not.toMatch(/Approver \(AF_TEST_APPROVER_UPN\)/);
  });
});
