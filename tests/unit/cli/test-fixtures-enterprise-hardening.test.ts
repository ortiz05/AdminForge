import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from '@adminforge/cli/src/commands/provision';
import { removeTestFixtures } from '@adminforge/cli/src/commands/test-fixtures';
import { DIRECTORY_MARKER, directoryCatalog } from '@adminforge/cli/src/provision/directory-fixture-catalog';
import { APPS_NOTES } from '@adminforge/cli/src/provision/apps-fixture-plan';
import { SIGNIN_MARKER } from '@adminforge/cli/src/provision/sign-ins-fixture';
import { createEnterpriseCloud, type EnterpriseCloudOptions } from './enterprise-fixtures-fake';

// The enterprise fixtures' safety rules (security review of 2026-10-17): someone else's objects at a fixture's names
// are refused and never removed; AF-Test-Group-01 receives policies only while it holds just the test accounts, and
// is nested or targeted only when it is the test identities' own (AF-Test-User-01..03 likewise); the sign-in accounts
// must hold nothing and stay disabled; fixture apps are never granted, consented or assigned anything; nothing is
// left unmarked when marking fails; leftovers are ✗ and removed whether or not still opted in.

// Each test runs whole provisioning passes against the fake cloud: generous on a busy host.
vi.setConfig({ testTimeout: 30_000 });

const TENANT = randomUUID();
const PROVISIONER = { clientId: randomUUID(), secret: 'provisioner-secret-never-printed' };
const SKU = randomUUID();

function setup(
  fixtures: string,
  cloudOpts: Partial<EnterpriseCloudOptions> = {},
  extra: Record<string, string> = {},
) {
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
    AF_TEST_LICENCE_SKU: 'SPE_E5',
    AF_TEST_FIXTURES: fixtures,
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
    now: () => new Date('2026-10-17T12:00:00Z'),
  };
  return { cloud, env, lines, ctx, text: () => lines.join('\n') };
}

type Cloud = ReturnType<typeof createEnterpriseCloud>;
const byUpn = (cloud: Cloud, upn: string) =>
  cloud.users.find((u) => String(u.userPrincipalName).toLowerCase() === upn);
const testGroup = (cloud: Cloud) => cloud.groups.find((g) => g.uniqueName === 'af-test-group-01')!;
const app = (cloud: Cloud, name: string) => cloud.apps.find((a) => a.displayName === name);
const stranger = (cloud: Cloud) => {
  const id = randomUUID();
  cloud.users.push({ id, userPrincipalName: 'someone@example.com', displayName: 'Someone' });
  return id;
};

/** The test identities first (AF-Test-User-01..03, AF-Test-Group-01), then the fixtures in `fixtures`. */
async function identitiesThen(fixtures: string, cloudOpts: Partial<EnterpriseCloudOptions> = {}) {
  const s = setup('', cloudOpts, { AF_TEST_LICENCE_SKU: '' });
  await provisionEntra(s.ctx);
  await provisionTestIdentities(s.ctx);
  Object.assign(s.env, { AF_TEST_FIXTURES: fixtures, AF_TEST_LICENCE_SKU: 'SPE_E5' });
  s.lines.length = 0;
  return s;
}

describe('AF-Test-Group-01 and the base targets', () => {
  it('intune-more refuses the assigned policies while AF-Test-Group-01 has someone else in it', async () => {
    const s = await identitiesThen('intune-more');
    s.cloud.members.push({ groupId: testGroup(s.cloud).id, memberId: stranger(s.cloud) });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/intune-more/);
    expect(s.text()).toMatch(/AF-Test Compliance \(iOS\).*1 member\(s\) that aren't provisioning's/s);
    // Only the unassigned policy was created; nothing was assigned to the group.
    expect(s.cloud.intune.deviceCompliancePolicies.map((p) => p.displayName)).toEqual([
      'AF-Test Compliance (macOS)',
    ]);
    expect(Object.values(s.cloud.appProtections).flat()).toEqual([]);
    s.lines.length = 0;
    await provisionStatus(s.ctx);
    expect(s.text()).toMatch(/AF-Test-Group-01 has 1 member\(s\).*the assigned enterprise ones are refused/);
  });

  it('a group at AF-Test-Group-01’s unique name that the test identities didn’t create is neither nested nor targeted', async () => {
    const s = await identitiesThen('directory,intune-more');
    testGroup(s.cloud).description = 'Someone else’s group';
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/could not be provisioned/);
    expect(s.text()).toMatch(/AF-Test-Nested-01.*member AF-Test-Group-01.*not created by provisioning/s);
    expect(s.text()).toMatch(/AF-Test Compliance \(iOS\).*isn't the one provisioning created/s);
    const nested = s.cloud.groups.find((g) => g.displayName === 'AF-Test-Nested-01')!;
    expect(s.cloud.members.filter((m) => m.groupId === nested.id).map((m) => m.memberId)).not.toContain(
      testGroup(s.cloud).id,
    );
  });

  it('an account at a base target’s UPN that isn’t provisioning’s is never added to the unit or given methods', async () => {
    const s = await identitiesThen('directory,auth-methods');
    const u2 = byUpn(s.cloud, 'af-test-user-02@example.com')!;
    u2.displayName = 'Someone else';
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/could not be provisioned/);
    expect(s.text()).toMatch(/AF-Test-AU-01.*member AF-Test-User-02.*not created by provisioning/s);
    expect(s.cloud.aus[0]!.memberIds).not.toContain(u2.id);
    expect(s.cloud.phones.get(u2.id as string) ?? []).toEqual([]);
  });
});

describe('someone else’s objects at a fixture’s names', () => {
  it('are refused (✗) and never removed: a group, an app, the unit, an Intune policy, a sign-in account', async () => {
    const s = await identitiesThen('directory,apps,intune-more,sign-ins');
    s.cloud.groups.push({ id: randomUUID(), displayName: 'AF-Test-Dynamic-01', description: 'theirs' });
    s.cloud.apps.push({
      id: randomUUID(),
      appId: randomUUID(),
      displayName: 'AF-Test-App-Hygiene',
      passwordCredentials: [],
    });
    s.cloud.aus.push({
      id: randomUUID(),
      displayName: 'AF-Test-AU-01',
      description: 'theirs',
      memberIds: [],
    });
    s.cloud.intune.deviceCompliancePolicies.push({
      id: randomUUID(),
      displayName: 'AF-Test Compliance (iOS)',
      description: 'theirs',
    });
    s.cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-test-signin-01@example.com',
      displayName: 'Someone',
    });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/could not be provisioned/);
    for (const title of [
      'AF-Test-Dynamic-01',
      'AF-Test-App-Hygiene',
      'AF-Test-AU-01',
      'AF-Test Compliance \\(iOS\\)',
      'AF-Test-SignIn-01',
    ])
      expect(s.text()).toMatch(new RegExp(`✗[^\\n]*${title}`));
    await removeTestFixtures(s.ctx);
    expect(
      s.cloud.groups.some((g) => g.displayName === 'AF-Test-Dynamic-01' && g.description === 'theirs'),
    ).toBe(true);
    expect(app(s.cloud, 'AF-Test-App-Hygiene')).toBeTruthy();
    expect(s.cloud.aus.some((a) => a.description === 'theirs')).toBe(true);
    expect(s.cloud.intune.deviceCompliancePolicies.some((p) => p.description === 'theirs')).toBe(true);
    expect(byUpn(s.cloud, 'af-test-signin-01@example.com')).toMatchObject({ displayName: 'Someone' });
  });
});

describe('the sign-in accounts', () => {
  it('holding anything is ✗ in status, and being enabled is ⚠', async () => {
    const s = await identitiesThen('sign-ins');
    await provisionTestIdentities(s.ctx);
    const one = byUpn(s.cloud, 'af-test-signin-01@example.com')!;
    s.cloud.members.push({ groupId: testGroup(s.cloud).id, memberId: one.id as string });
    byUpn(s.cloud, 'af-test-signin-02@example.com')!.accountEnabled = true;
    s.lines.length = 0;
    const status = await provisionStatus(s.ctx);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-SignIn-01[^\n]*holds 1 group \/ unit \/ role membership/);
    expect(s.text()).toMatch(/⚠ A sign-in account \(AF-Test-SignIn-01\/02\) is enabled/);
    expect(status.failures.some((f) => /AF-Test-SignIn-01/.test(f))).toBe(true);
  });

  it('--disable uses the stored UPNs and says when it can’t look', async () => {
    const s = await identitiesThen('sign-ins');
    await provisionTestIdentities(s.ctx);
    byUpn(s.cloud, 'af-test-signin-01@example.com')!.accountEnabled = true;
    s.env.AF_TEST_USER_UPN = 'af-tester@example.com';
    s.env.AF_PRIMARY_DOMAIN = '';
    await setTesterEnabled(s.ctx, false);
    expect(byUpn(s.cloud, 'af-test-signin-01@example.com')!.accountEnabled).toBe(false);
    s.env.AF_TEST_SIGNIN_1_UPN = '';
    s.env.AF_TEST_SIGNIN_2_UPN = '';
    s.lines.length = 0;
    await setTesterEnabled(s.ctx, false);
    expect(s.text()).toMatch(/Sign-in accounts: .* not set — not checked/);
  });
});

describe('the Microsoft 365 groups’ owners', () => {
  const group = (cloud: Cloud, name: string) => cloud.groups.find((g) => g.displayName === name)!;
  const provisionerSp = (cloud: Cloud) =>
    cloud.sps.find((sp) => sp.appId === PROVISIONER.clientId)!.id as string;

  it('the catalogue expects a person and the app on M365-01, nobody on M365-02', () => {
    const groups = directoryCatalog('example.com').groups;
    expect(groups.find((g) => g.key === 'm365')).toMatchObject({
      provisionerOwner: 'keep',
      expectedOwners: 2,
    });
    expect(groups.find((g) => g.key === 'm365NoOwner')).toMatchObject({
      provisionerOwner: 'remove',
      expectedOwners: 0,
    });
  });

  it('converges: the provisioner is taken off M365-02 again and put back on M365-01', async () => {
    const s = await identitiesThen('directory');
    await provisionTestIdentities(s.ctx);
    const sp = provisionerSp(s.cloud);
    const m1 = group(s.cloud, 'AF-Test-M365-01').id as string;
    const m2 = group(s.cloud, 'AF-Test-M365-02').id as string;
    expect(s.cloud.owners.get(m1)).toContain(sp);
    expect(s.cloud.owners.get(m2) ?? []).toEqual([]);
    s.cloud.owners.set(m2, [sp]);
    s.cloud.owners.set(
      m1,
      (s.cloud.owners.get(m1) ?? []).filter((id) => id !== sp),
    );
    await provisionTestIdentities(s.ctx);
    expect(s.cloud.owners.get(m2)).toEqual([]);
    expect(s.cloud.owners.get(m1)).toContain(sp);
    // Removal is only ever of the provisioner's own reference on the marked M365-02.
    expect(
      s.cloud.calls
        .filter((c) => /\/groups\/[^/]+\/owners\/[^/]+\/\$ref/.test(c) && c.startsWith('DELETE'))
        .every((c) => c.includes(m2) && c.includes(sp)),
    ).toBe(true);
  });

  it('someone else as an owner of M365-02 is ✗ and left alone', async () => {
    const s = await identitiesThen('directory');
    await provisionTestIdentities(s.ctx);
    const m2 = group(s.cloud, 'AF-Test-M365-02').id as string;
    const other = stranger(s.cloud);
    s.cloud.owners.set(m2, [other]);
    s.lines.length = 0;
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/directory/);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-M365-02[^\n]*1 owner\(s\) provisioning didn't add/);
    expect(s.cloud.owners.get(m2)).toEqual([other]);
  });
});

describe('the fixture apps', () => {
  it('a service principal on a fixture app, or a grant or assignment on the SAML app, is ✗', async () => {
    const s = await identitiesThen('apps');
    await provisionTestIdentities(s.ctx);
    s.cloud.sps.push({
      id: randomUUID(),
      appId: app(s.cloud, 'AF-Test-App-Risky')!.appId,
      displayName: 'consented',
    });
    const saml = s.cloud.sps.find((sp) => sp.appId === app(s.cloud, 'AF-Test-SAML-01')!.appId)!;
    s.cloud.assignments.push({
      id: randomUUID(),
      principalId: randomUUID(),
      resourceId: saml.id,
      appRoleId: randomUUID(),
    });
    s.lines.length = 0;
    await provisionStatus(s.ctx);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-App-Risky[^\n]*service principal/);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-SAML-01[^\n]*1 assignment/);
  });

  it('the risky app is ownerless: provisioning takes back an owner it added, and refuses anyone else', async () => {
    const s = await identitiesThen('apps');
    await provisionTestIdentities(s.ctx);
    const risky = app(s.cloud, 'AF-Test-App-Risky')!;
    expect(s.cloud.owners.get(risky.id as string) ?? []).toEqual([]);
    const target01 = byUpn(s.cloud, 'af-test-user-01@example.com')!;
    s.cloud.owners.set(risky.id as string, [target01.id as string]);
    await provisionTestIdentities(s.ctx);
    expect(s.cloud.owners.get(risky.id as string)).toEqual([]);
    s.cloud.owners.set(risky.id as string, [randomUUID()]);
    s.lines.length = 0;
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/apps/);
    expect(s.text()).toMatch(/AF-Test-App-Risky.*1 owner\(s\) provisioning didn't add/s);
  });

  it('a SAML app that can’t be marked is deleted again', async () => {
    const s = await identitiesThen('apps', { failSamlMark: true });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/apps/);
    expect(app(s.cloud, 'AF-Test-SAML-01')).toBeUndefined();
    expect(s.cloud.apps.filter((a) => a.notes === APPS_NOTES)).toHaveLength(4);
  });
});

describe('the guest', () => {
  it('needs its marker: an unmarked guest at its address is refused and never removed', async () => {
    const s = await identitiesThen('guest');
    s.cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-test-guest-01_example.com#EXT#@example.com',
      displayName: 'AF-Test-Guest-01',
      mail: 'af-test-guest-01@example.com',
      userType: 'Guest',
    });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/guest/);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-Guest-01[^\n]*not created by provisioning/);
    await removeTestFixtures(s.ctx);
    expect(s.cloud.users.filter((u) => u.userType === 'Guest')).toHaveLength(1);
  });

  it('an invited guest that can’t be marked is deleted again (the directly created one is marked from the start)', async () => {
    const s = await identitiesThen('guest', { failGuestMark: true });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/guest/);
    expect(s.cloud.users.filter((u) => u.displayName === 'AF-Test-Guest-01')).toEqual([]);
    expect(s.cloud.users.find((u) => u.displayName === 'AF-Test-Guest-02')).toMatchObject({
      employeeType: DIRECTORY_MARKER,
    });
  });

  it('an unmarked account at a guest’s UPN is refused and never removed', async () => {
    const s = await identitiesThen('guest');
    s.cloud.users.push({
      id: randomUUID(),
      userPrincipalName: 'af-test-guest-02_example.com#EXT#@example.com',
      displayName: 'Someone else',
      userType: 'Guest',
    });
    await expect(provisionTestIdentities(s.ctx)).rejects.toThrow(/guest/);
    expect(s.text()).toMatch(/✗[^\n]*AF-Test-Guest-02[^\n]*not created by provisioning/);
    await removeTestFixtures(s.ctx);
    expect(s.cloud.users.filter((u) => u.displayName === 'Someone else')).toHaveLength(1);
  });

  it('a marked guest is removed by --remove-fixtures', async () => {
    const s = await identitiesThen('guest');
    await provisionTestIdentities(s.ctx);
    expect(s.cloud.users.filter((u) => u.userType === 'Guest').map((u) => u.employeeType)).toEqual([
      DIRECTORY_MARKER,
      DIRECTORY_MARKER,
    ]);
    await removeTestFixtures(s.ctx);
    expect(s.cloud.users.filter((u) => u.userType === 'Guest')).toEqual([]);
  });
});

describe('leftovers and removal', () => {
  it('a fixture taken out of AF_TEST_FIXTURES is ✗ in status, and --remove-fixtures still removes it', async () => {
    const s = await identitiesThen('sign-ins');
    await provisionTestIdentities(s.ctx);
    s.env.AF_TEST_FIXTURES = '';
    s.lines.length = 0;
    await provisionStatus(s.ctx);
    expect(s.text()).toMatch(/✗[^\n]*sign-ins: 2 object\(s\) left over/);
    await removeTestFixtures(s.ctx);
    expect(s.cloud.users.filter((u) => u.employeeType === SIGNIN_MARKER)).toEqual([]);
  });

  it('fixture objects in a label that is not a test environment fail `provision status`', async () => {
    const s = await identitiesThen('apps');
    await provisionTestIdentities(s.ctx);
    s.env.AF_ENV_LABEL = 'prod';
    s.lines.length = 0;
    const status = await provisionStatus(s.ctx);
    expect(s.text()).toMatch(/✗ \d+ AF-Test fixture object\(s\) left over in a non-test environment/);
    expect(status.ok).toBe(false);
  });

  it('--remove-fixtures exits 1 when a fixture couldn’t be read, never "nothing to remove"', async () => {
    const s = await identitiesThen('auth-methods');
    const base = s.ctx.fetch!;
    s.ctx.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/authentication\/phoneMethods/.test(String(input))
        ? new Response(JSON.stringify({ error: { code: 'accessDenied', message: 'no' } }), { status: 403 })
        : base(input, init)) as typeof fetch;
    await expect(removeTestFixtures(s.ctx)).rejects.toThrow(/auth-methods/);
    expect(s.text()).not.toMatch(/Nothing to remove/);
  });
});
