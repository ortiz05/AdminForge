import { randomUUID, X509Certificate } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from '@adminforge/cli/src/commands/provision';
import { removeTestFixtures } from '@adminforge/cli/src/commands/test-fixtures';
import { DIRECTORY_MARKER, DYNAMIC_RULE } from '@adminforge/cli/src/provision/directory-fixture-catalog';
import { APPS_NOTES, MAIL_READWRITE_ROLE } from '@adminforge/cli/src/provision/apps-fixture-plan';
import { FIXTURE_PHONE } from '@adminforge/cli/src/provision/auth-methods-fixture';
import { SIGNIN_MARKER } from '@adminforge/cli/src/provision/sign-ins-fixture';
import { STANDING_FIXTURE_PERMISSIONS } from '@adminforge/cli/src/provision/fixtures-model';
import { GROUP_TARGET } from '@adminforge/cli/src/provision/fixtures-model';
import { selfSignedCertificate } from '@adminforge/cli/src/provision/self-signed-certificate';
import { createEnterpriseCloud, type EnterpriseCloudOptions } from './enterprise-fixtures-fake';

// The enterprise test fixtures (`directory`, `apps`, `auth-methods`, `intune-more`, `sign-ins`) through
// `provision test-identities`, `provision status`, `--remove-fixtures` and `--disable`, against the fake cloud:
// everything is created marked, a second run has nothing to do, foreign objects are refused and never removed, and no
// password, secret or Temporary Access Pass reaches the output.

// Each test runs whole provisioning passes against the fake cloud: generous on a busy host.
vi.setConfig({ testTimeout: 30_000 });

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const SKU = randomUUID();
const ALL = {
  AF_TEST_LICENCE_SKU: 'SPE_E5',
  AF_TEST_FIXTURES: 'directory,guest,apps,auth-methods,intune-more,sign-ins',
};

function setup(extra: Record<string, string> = {}, cloudOpts: Partial<EnterpriseCloudOptions> = {}) {
  const cloud = createEnterpriseCloud({
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
    now: () => new Date('2026-10-17T12:00:00Z'),
  };
  return { cloud, env, lines, written, ctx };
}

const byUpn = (cloud: ReturnType<typeof createEnterpriseCloud>, upn: string) =>
  cloud.users.find((u) => String(u.userPrincipalName).toLowerCase() === upn);
const groupNamed = (cloud: ReturnType<typeof createEnterpriseCloud>, name: string) =>
  cloud.groups.find((g) => g.displayName === name);
const appNamed = (cloud: ReturnType<typeof createEnterpriseCloud>, name: string) =>
  cloud.apps.find((a) => a.displayName === name);

async function provisioned(
  extra: Record<string, string> = {},
  cloudOpts: Partial<EnterpriseCloudOptions> = {},
) {
  const s = setup({ ...ALL, ...extra }, cloudOpts);
  await provisionEntra(s.ctx);
  await provisionTestIdentities(s.ctx);
  return s;
}

describe('directory fixture', () => {
  it('creates AF-Test-User-04..12 marked, with attributes, a manager chain and licences', async () => {
    const { cloud } = await provisioned();
    for (const n of ['04', '05', '06', '07', '08', '09', '10', '11', '12'])
      expect(byUpn(cloud, `af-test-user-${n}@example.com`)).toMatchObject({
        displayName: `AF-Test-User-${n}`,
        employeeType: DIRECTORY_MARKER,
      });
    const u = (n: string) => byUpn(cloud, `af-test-user-${n}@example.com`)!;
    expect(u('04')).toMatchObject({ surname: "O'Brien", department: 'AF-Test Sales', usageLocation: 'GB' });
    expect(u('07').accountEnabled).toBe(false);
    expect(u('08')).toMatchObject({ accountEnabled: false, assignedLicenses: [{ skuId: SKU }] });
    expect(u('09').department).toBeUndefined();
    expect(u('10').passwordPolicies).toBe('DisablePasswordExpiration');
    expect(u('09').usageLocation).toBeUndefined();
    // Manager chain: 05 → 04 → 06 → 07 (disabled).
    expect(cloud.managers.get(u('05').id as string)).toBe(u('04').id);
    expect(cloud.managers.get(u('04').id as string)).toBe(u('06').id);
    expect(cloud.managers.get(u('06').id as string)).toBe(u('07').id);
  });

  it('creates the guest without an invitation email, the groups and the administrative unit', async () => {
    const { cloud } = await provisioned();
    const guest = cloud.users.find((x) => x.userType === 'Guest')!;
    expect(guest).toMatchObject({ displayName: 'AF-Test-Guest-01', employeeType: DIRECTORY_MARKER });
    expect(cloud.calls.filter((c) => c.endsWith('/invitations'))).toHaveLength(1);
    expect(groupNamed(cloud, 'AF-Test-Dynamic-01')).toMatchObject({
      groupTypes: ['DynamicMembership'],
      membershipRule: DYNAMIC_RULE,
    });
    const members = (name: string) =>
      cloud.members.filter((m) => m.groupId === groupNamed(cloud, name)!.id).map((m) => m.memberId);
    expect(members('AF-Test-Nested-01')).toContain(
      cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!.id,
    );
    expect(members('AF-Test-Empty-01')).toEqual([]);
    expect(cloud.owners.get(groupNamed(cloud, 'AF-Test-M365-01')!.id as string)).toHaveLength(1);
    expect(cloud.owners.get(groupNamed(cloud, 'AF-Test-M365-02')!.id as string) ?? []).toEqual([]);
    expect(groupNamed(cloud, 'AF-Test-Licence-01')!.assignedLicenses).toEqual([
      { skuId: SKU, disabledPlans: [cloud.plans.SWAY] },
    ]);
    // Every AF-Test user (01..12) in the unit; nobody else.
    expect(cloud.aus).toHaveLength(1);
    expect(cloud.aus[0]!.memberIds).toHaveLength(12);
    expect(String(cloud.aus[0]!.description)).toContain('AdminForge validation');
  });

  it('plans no licence when the subscription lacks the seats, and says so', async () => {
    const s = setup(ALL, { skus: [{ skuId: SKU, skuPartNumber: 'SPE_E5', consumedUnits: 24, enabled: 25 }] });
    await provisionEntra(s.ctx);
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/directory/);
    expect(s.lines.join('\n')).toMatch(/SPE_E5 for the directory fixture.*no free seat/s);
    expect(byUpn(s.cloud, 'af-test-user-08@example.com')!.assignedLicenses ?? []).toEqual([]);
  });

  it('refuses an account at a catalogue UPN that is not provisioning’s, and never removes it', async () => {
    const s = setup(ALL);
    await provisionEntra(s.ctx);
    s.cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-test-user-04@example.com',
      displayName: 'Someone',
    });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/fixture\(s\) could not be provisioned/);
    expect(s.lines.join('\n')).toMatch(/AF-Test-User-04 \(user\).*not created by provisioning/s);
    await removeTestFixtures(s.ctx);
    expect(byUpn(s.cloud, 'af-test-user-04@example.com')).toMatchObject({ displayName: 'Someone' });
  });
});

describe('apps fixture', () => {
  it('creates the apps marked and never granted anything, with expiring and long-lived credentials', async () => {
    const { cloud, lines } = await provisioned();
    for (const name of [
      'AF-Test-App-Expiring',
      'AF-Test-App-Hygiene',
      'AF-Test-App-Risky',
      'AF-Test-App-NoOwner',
      'AF-Test-SAML-01',
    ])
      expect(appNamed(cloud, name)?.notes).toBe(APPS_NOTES);
    const expiring = appNamed(cloud, 'AF-Test-App-Expiring')!;
    const end = (c: { endDateTime?: unknown }) =>
      new Date(String(c.endDateTime)).getTime() - Date.parse('2026-10-17T12:00:00Z');
    expect((expiring.passwordCredentials as Array<{ endDateTime: string }>).map(end)).toEqual([7 * 864e5]);
    expect(
      (expiring.keyCredentials as Array<{ endDateTime: string }>).map((c) => Math.round(end(c) / 864e5)),
    ).toEqual([20]);
    expect((appNamed(cloud, 'AF-Test-App-Hygiene')!.passwordCredentials as unknown[]).length).toBe(3);
    expect(appNamed(cloud, 'AF-Test-App-Risky')!.requiredResourceAccess).toEqual([
      expect.objectContaining({ resourceAccess: [{ id: MAIL_READWRITE_ROLE, type: 'Role' }] }),
    ]);
    expect(cloud.owners.get(appNamed(cloud, 'AF-Test-App-NoOwner')!.id as string) ?? []).toEqual([]);
    // Never consented or granted: no app role assignment or grant on any fixture app.
    const fixtureSps = cloud.sps
      .filter((s) => cloud.apps.some((a) => a.appId === s.appId && a.notes === APPS_NOTES))
      .map((s) => s.id);
    expect(cloud.assignments.filter((a) => fixtureSps.includes(a.principalId as string))).toEqual([]);
    expect(cloud.grants.filter((g) => fixtureSps.includes(g.clientId as string))).toEqual([]);
    // The SAML app: SAML mode and a signing certificate expiring within a month.
    const saml = cloud.sps.find((s) => s.appId === appNamed(cloud, 'AF-Test-SAML-01')!.appId)!;
    expect(saml.preferredSingleSignOnMode).toBe('saml');
    // Nobody is assigned and assignment is required: nobody can sign in to it.
    expect(saml.appRoleAssignmentRequired).toBe(true);
    expect(saml.preferredTokenSigningKeyThumbprint).toBeTruthy();
    // No secret value reaches the output.
    for (const secret of cloud.secrets.values()) expect(lines.join('\n')).not.toContain(secret);
  });

  it('replaces the expiring credentials once they have expired', async () => {
    const s = await provisioned();
    s.ctx.now = () => new Date('2026-11-20T12:00:00Z');
    await provisionTestIdentities(s.ctx);
    const expiring = appNamed(s.cloud, 'AF-Test-App-Expiring')!;
    const ends = (expiring.passwordCredentials as Array<{ endDateTime: string }>).map((c) => c.endDateTime);
    expect(ends).toEqual([new Date(Date.parse('2026-11-20T12:00:00Z') + 7 * 864e5).toISOString()]);
  });
});

describe('auth-methods fixture', () => {
  it('adds the fictitious SMS number and a TAP whose code never reaches the output', async () => {
    const { cloud, lines } = await provisioned();
    const u2 = byUpn(cloud, 'af-test-user-02@example.com')!;
    const u3 = byUpn(cloud, 'af-test-user-03@example.com')!;
    expect(cloud.phones.get(u2.id as string)).toEqual([
      expect.objectContaining({ phoneNumber: FIXTURE_PHONE, phoneType: 'mobile' }),
    ]);
    expect(cloud.taps.get(u3.id as string)).toHaveLength(1);
    expect(cloud.tapCodes).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(cloud.tapCodes[0]);
  });
});

describe('intune-more fixture', () => {
  it('creates the policies marked, assigned to AF-Test-Group-01 only (macOS unassigned)', async () => {
    const { cloud } = await provisioned();
    const group = cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
    const compliance = cloud.intune.deviceCompliancePolicies;
    expect(compliance.map((p) => p.displayName).sort()).toEqual([
      'AF-Test Compliance (Android)',
      'AF-Test Compliance (iOS)',
      'AF-Test Compliance (macOS)',
    ]);
    for (const p of compliance)
      expect(cloud.policyAssignments.get(String(p.id))).toEqual(
        p.displayName === 'AF-Test Compliance (macOS)'
          ? []
          : [{ '@odata.type': GROUP_TARGET, groupId: group.id }],
      );
    expect(cloud.intune.deviceConfigurations.map((p) => p.displayName)).toEqual([
      'AF-Test Update ring (Windows)',
    ]);
    for (const list of Object.values(cloud.appProtections)) {
      expect(list).toHaveLength(1);
      expect(cloud.appProtectionAssignments.get(String(list[0]!.id))).toEqual([
        { '@odata.type': GROUP_TARGET, groupId: group.id },
      ]);
    }
  });
});

describe('sign-ins fixture', () => {
  it('creates two disabled marked accounts with no role, their passwords only in the admin env', async () => {
    const { cloud, lines, written } = await provisioned();
    for (const n of ['01', '02']) {
      const u = byUpn(cloud, `af-test-signin-${n}@example.com`)!;
      expect(u).toMatchObject({ accountEnabled: false, employeeType: SIGNIN_MARKER });
      expect(cloud.members.some((m) => m.memberId === u.id)).toBe(false);
      expect(cloud.roleAssignments.some((r) => r.principalId === u.id)).toBe(false);
    }
    const creds = written.find((w) => w.AF_TEST_SIGNIN_1_PASSWORD);
    expect(creds).toMatchObject({ AF_TEST_SIGNIN_1_UPN: 'af-test-signin-01@example.com' });
    expect(lines.join('\n')).not.toContain(creds!.AF_TEST_SIGNIN_1_PASSWORD);
  });

  it('--disable disables the sign-in accounts with the testers', async () => {
    const s = await provisioned();
    for (const n of ['01', '02']) byUpn(s.cloud, `af-test-signin-${n}@example.com`)!.accountEnabled = true;
    await setTesterEnabled(s.ctx, false);
    for (const n of ['01', '02'])
      expect(byUpn(s.cloud, `af-test-signin-${n}@example.com`)!.accountEnabled).toBe(false);
    expect(s.lines.join('\n')).toMatch(/Sign-in accounts: 2 disabled/);
  });
});

describe('all enterprise fixtures', () => {
  it('a second run has nothing to do and `provision status` shows them ✓', async () => {
    const s = await provisioned();
    const run = await provisionTestIdentities(s.ctx);
    const changes = run.fixtureOps.filter(
      (o) => o.action !== 'noop' && !(o.kind === 'note' && o.action === 'skip' && !o.blocked),
    );
    expect(changes.map((o) => `${o.action} ${o.title}`)).toEqual([]);
    s.lines.length = 0;
    const status = await provisionStatus(s.ctx);
    const text = s.lines.join('\n');
    expect(text).toMatch(/✓ AF-Test-User-04 \(user\)/);
    expect(text).toMatch(/✓ AF-Test-App-Expiring/);
    expect(status.failures.filter((f) => /AF-Test|SignIn/.test(f))).toEqual([]);
  });

  it('--remove-fixtures removes every marked object and clears the sign-in passwords', async () => {
    const s = await provisioned();
    await removeTestFixtures(s.ctx);
    expect(
      s.cloud.users.filter((u) => u.employeeType === DIRECTORY_MARKER || u.employeeType === SIGNIN_MARKER),
    ).toEqual([]);
    expect(s.cloud.apps.filter((a) => a.notes === APPS_NOTES)).toEqual([]);
    expect(
      s.cloud.groups.filter((g) =>
        /^AF-Test-(Dynamic|Nested|M365|Empty|Licence)/.test(String(g.displayName)),
      ),
    ).toEqual([]);
    expect(s.cloud.aus).toEqual([]);
    expect([...s.cloud.phones.values()].flat()).toEqual([]);
    expect([...s.cloud.taps.values()].flat()).toEqual([]);
    expect(s.cloud.intune.deviceCompliancePolicies).toEqual([]);
    expect(s.env.AF_TEST_SIGNIN_1_PASSWORD).toBe('');
    // The base test identities stay.
    expect(byUpn(s.cloud, 'af-test-user-01@example.com')).toBeTruthy();
  });

  it('a refused invitation prints ✗ with the permission and the rest goes on', async () => {
    const s = setup(ALL, { forbidInvitations: true });
    await provisionEntra(s.ctx);
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/\(guest\)/);
    const text = s.lines.join('\n');
    expect(text).toMatch(/✗ AF-Test-Guest-01.*User\.Invite\.All/);
    // The directory fixture itself is unaffected.
    expect(groupNamed(s.cloud, 'AF-Test-Dynamic-01')).toBeTruthy();
    expect(appNamed(s.cloud, 'AF-Test-App-Expiring')).toBeTruthy();
  });

  it('skips the guest (no ✗) where the tenant allows no guest invitations', async () => {
    const s = setup(ALL, { invitesFrom: 'none' });
    await provisionEntra(s.ctx);
    await provisionTestIdentities(s.ctx);
    expect(s.cloud.users.some((u) => u.userType === 'Guest')).toBe(false);
    expect(s.lines.join('\n')).toMatch(/AF-Test-Guest-01.*doesn't allow guest invitations/s);
  });

  it('every new fixture permission is a standing one `provision status` warns about', () => {
    for (const p of [
      'User.Invite.All',
      'UserAuthenticationMethod.ReadWrite.All',
      'DeviceManagementApps.ReadWrite.All',
    ])
      expect(STANDING_FIXTURE_PERMISSIONS).toContain(p);
  });
});

describe('self-signed certificate', () => {
  it('is a valid self-signed X.509 certificate with exactly the asked validity, public part only', () => {
    const from = new Date('2026-10-17T12:00:00Z');
    const to = new Date('2026-11-06T12:00:00Z');
    const der = selfSignedCertificate('AF-Test-App-Expiring', from, to);
    const cert = new X509Certificate(der);
    expect(cert.subject).toBe('CN=AF-Test-App-Expiring');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validFrom).toISOString()).toBe(from.toISOString());
    expect(new Date(cert.validTo).toISOString()).toBe(to.toISOString());
    expect(der.toString('latin1')).not.toMatch(/PRIVATE KEY/);
  });

  it('is valid DER whatever the random serial: positive, minimal (first byte 0x40–0x7f)', () => {
    const from = new Date('2026-10-17T12:00:00Z');
    const to = new Date('2026-11-06T12:00:00Z');
    for (let i = 0; i < 12; i++) {
      const cert = new X509Certificate(selfSignedCertificate(`AF-Test-${i}`, from, to));
      const first = parseInt(cert.serialNumber.slice(0, 2), 16);
      expect(cert.serialNumber).toHaveLength(32);
      expect(first >= 0x40 && first <= 0x7f).toBe(true);
    }
  });
});
