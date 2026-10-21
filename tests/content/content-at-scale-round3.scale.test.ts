import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Third content-scale round (plan 2026-10-17 Phase A1): the app permission, consent, credential, ownerless-app, MFA,
// licence and privileged-role reports classify and join natively ($unnest, $attach, $pick, $pluck, $withCount and
// $applyAdvanced with a date shifted by days). Each test runs the definition's own transforms on synthetic rows at
// the size they must handle, with the real 250 ms budget; list datasources feed a capped page view and the export.

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const NOW = '2026-10-17T12:00:00Z';
const transform = (
  id: string,
  ds: string,
  scope: { value?: unknown; ds?: Record<string, unknown>; params?: Record<string, unknown> },
) =>
  renderString(def(id).datasources[ds].transform, {
    now: NOW,
    user: {},
    env: {},
    params: {},
    ...scope,
  }) as Promise<Def>;
const MICROSOFT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
// Credential dates are relative to the real clock: the reports compare with $iso(), not the scope's `now`.
const DAY = 864e5;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const unique = (rows: Def[], key: string) => new Set(rows.map((r) => r[key])).size === rows.length;

describe('app permissions and consent at scale', { retry: 2 }, () => {
  it('identity.app-permissions: 30k grants (the enterprise tenant) classified and joined to 1,000 holders; the page shows 2,000', async () => {
    // r0, r4, … critical; r1 high; r2 medium; r3 low.
    const NAMES = ['Directory.ReadWrite.All', 'Mail.Read', 'User.Read.All', 'Reports.Read'];
    const roles = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`r${i}`, NAMES[i % 4]]));
    const grants = Array.from({ length: 30_000 }, (_, i) => ({
      id: `g${i}`,
      appRoleId: `r${i % 200}`,
      principalId: `sp${i % 5000}`,
      principalDisplayName: `App ${String(i % 5000).padStart(4, '0')}`,
      resourceDisplayName: 'Microsoft Graph',
      createdDateTime: NOW,
    }));
    const holders = Array.from({ length: 1000 }, (_, i) => ({
      id: `sp${i}`,
      appId: `app${i}`,
      servicePrincipalType: i % 10 === 0 ? 'ManagedIdentity' : 'Application',
      appOwnerOrganizationId: [MICROSOFT, ORG, OTHER][i % 3],
      verifiedPublisher: i % 2 ? { displayName: 'Example Publisher' } : {},
      accountEnabled: true,
      displayName: `App ${i}`,
      tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
    }));
    const list = await transform('identity.app-permissions', 'permissionList', {
      value: { grants, roles, org: ORG, holders },
      params: { tier: 'all', holder: 'Any' },
    });
    expect(list.rows).toHaveLength(30_000);
    expect(list.figures).toMatchObject({ critical: 7500, total: 30_000 });
    expect(list.rows[0]).toMatchObject({ tier: 'critical', permission: 'Directory.ReadWrite.All' });
    expect(list.rows.at(-1)).toMatchObject({ tier: 'low' });
    // Holders past the 1,000 the directory lookup reads are labelled, not dropped.
    expect(list.rows.find((r: Def) => r.principalId === 'sp4999').sp).toMatchObject({ holder: 'Unknown' });
    expect(list.rows.find((r: Def) => r.principalId === 'sp10').sp).toMatchObject({
      holder: 'Managed identity',
    });
    const third = list.rows.find((r: Def) => r.principalId === 'sp2');
    expect(third.sp).toMatchObject({
      holder: 'Other organisation',
      verifiedPublisher: { displayName: 'Unverified publisher' },
    });
    expect(third.sp).not.toHaveProperty('tags'); // holders are trimmed to what the table shows

    const page = await transform('identity.app-permissions', 'permissions', {
      value: {
        first: list.rows.slice(0, 2000),
        count: list.rows.length,
        figures: list.figures,
        truncated: true,
      },
    });
    expect(page).toMatchObject({ critical: 7500, listCapped: true, listTotal: 30_000, truncated: true });
    expect(page.rows).toHaveLength(2000);
    expect(def('identity.app-permissions').export.data).toBe('permissionList.rows');
  });

  it('identity.consent-grants: 30k grants tiered by scope, client/API/user joined in one pass', async () => {
    const SCOPES = [
      ' openid profile Directory.ReadWrite.All',
      ' Mail.Read offline_access',
      ' User.Read',
      ' Files.ReadWrite',
    ];
    const grants = Array.from({ length: 30_000 }, (_, i) => ({
      id: `cg${i}`,
      clientId: `c${i % 3000}`,
      resourceId: 'graph',
      principalId: i % 5 === 0 ? null : `u${i % 700}`,
      consentType: i % 5 === 0 ? 'AllPrincipals' : 'Principal',
      scope: SCOPES[i % 4],
    }));
    const objects = [
      {
        id: 'graph',
        appId: '00000003-0000-0000-c000-000000000000',
        displayName: 'Microsoft Graph',
        appOwnerOrganizationId: MICROSOFT,
      },
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `c${i}`,
        appId: `app${i}`,
        displayName: `Client ${i}`,
        appOwnerOrganizationId: i % 2 ? ORG : OTHER,
        verifiedPublisher: {},
      })),
      ...Array.from({ length: 700 }, (_, i) => ({
        id: `u${i}`,
        displayName: `User ${i}`,
        userPrincipalName: `u${i}@example.com`,
      })),
    ];
    const list = await transform('identity.consent-grants', 'grantList', {
      value: { grants, objects, org: ORG, truncated: true },
      params: { consent: 'Any', risk: 'risky' },
    });
    // Risky = critical (scope 0) and high (scopes 1 and 3); low (scope 2) only with risk=all.
    expect(list.rows).toHaveLength(22_500);
    expect(list.figures).toMatchObject({ critical: 7500, apps: 2250, truncated: true });
    expect(list.figures.adminRisky + list.figures.userRisky).toBe(22_500);
    expect(list.rows[0].sc).toMatchObject({ tier: 'critical', risky: ['Directory.ReadWrite.All'] });
    expect(list.rows.at(-1).sc.tier).toBe('high');
    const known = list.rows.find((r: Def) => r.clientId === 'c1' && r.principalId);
    expect(known).toMatchObject({
      client: { origin: 'This organisation' },
      resource: { displayName: 'Microsoft Graph' },
    });
    expect(known.who.userPrincipalName).toMatch(/@example\.com$/);
    expect(list.rows.find((r: Def) => r.clientId === 'c2999').client).toMatchObject({ origin: 'Unknown' });

    const page = await transform('identity.consent-grants', 'report', {
      value: { first: list.rows.slice(0, 2000), count: list.rows.length, figures: list.figures },
    });
    expect(page).toMatchObject({ listCapped: true, listTotal: 22_500, critical: 7500 });
    expect(page.rows).toHaveLength(2000);
    expect(page.rows.find((r: Def) => r.consentType === 'AllPrincipals').who).toEqual({
      displayName: 'All users',
    });
    // The export says "All users" for admin grants too.
    const admin = list.rows.filter((r: Def) => r.consentType === 'AllPrincipals');
    expect(admin.every((r: Def) => r.who.displayName === 'All users')).toBe(true);
    // Apps, APIs and users the names lookup missed show by their object id on the page.
    const missed = list.rows.find((r: Def) => r.clientId === 'c2999' && r.consentType === 'Principal');
    const fallback = await transform('identity.consent-grants', 'report', {
      value: {
        first: [
          { ...missed, resource: undefined, resourceId: 'api-x', who: undefined, principalId: 'user-x' },
        ],
        count: 1,
        figures: list.figures,
      },
    });
    expect(fallback.rows[0]).toMatchObject({
      client: { displayName: 'c2999', origin: 'Unknown' },
      resource: { displayName: 'api-x' },
      who: { displayName: 'user-x' },
    });
    expect(def('identity.consent-grants').export.data).toBe('grantList.rows');
  });
});

describe('credentials and ownerless apps at scale', { retry: 2 }, () => {
  // App i has i % 4 live secrets; lifetimes cycle 90, 400, 4000 and 200 days (started 30 days ago).
  const LIFETIMES = [90, 400, 4000, 200];
  const secret = (i: number, k: number, lifetime = LIFETIMES[(i + k) % 4]!) => ({
    keyId: `k${i}-${k}`,
    displayName: `secret ${k}`,
    startDateTime: at(-30),
    endDateTime: at(lifetime - 30),
  });
  const expired = { keyId: 'old', displayName: 'expired', startDateTime: at(-400), endDateTime: at(-10) };
  const apps = Array.from({ length: 20_000 }, (_, i) => ({
    id: `a${i}`,
    appId: `app${i}`,
    displayName: `App ${String(i).padStart(5, '0')}`,
    signInAudience: i % 3 ? 'AzureADMyOrg' : 'AzureADMultipleOrgs',
    passwordCredentials: [
      ...Array.from({ length: i % 4 }, (_, k) => secret(i, k)),
      ...(i % 7 === 0 ? [expired] : []),
    ],
    keyCredentials: i % 5 === 0 ? [secret(i, 9, 365)] : [],
    requiredResourceAccess: i % 6 === 0 ? [{ resourceAccess: [{ id: 'r', type: 'Role' }] }] : [],
  }));
  const sps = Array.from({ length: 20_000 }, (_, i) => ({
    id: `s${i}`,
    appId: `spapp${i}`,
    displayName: `Enterprise ${i}`,
    servicePrincipalType: i % 10 === 0 ? 'ManagedIdentity' : 'Application',
    preferredSingleSignOnMode: i % 50 === 1 ? 'saml' : null,
    appOwnerOrganizationId: i % 2 ? MICROSOFT : OTHER,
    accountEnabled: i % 9 !== 0,
    appRoleAssignmentRequired: i % 4 === 0,
    verifiedPublisher: i % 3 ? { displayName: `Publisher ${i % 40}` } : {},
    passwordCredentials: i % 20 === 0 ? [secret(i, 1, i % 40 === 0 ? 400 : 90)] : [],
    keyCredentials: i % 7 === 0 ? [secret(i, 2, 365)] : [],
  }));

  it('identity.app-credential-hygiene: 20k apps and 20k enterprise apps; page capped at 2,000, export complete', async () => {
    const id = 'identity.app-credential-hygiene';
    const params = { maxDays: 365, finding: 'Any' };
    const secrets = await transform(id, 'secrets', { value: { apps }, params });
    const liveSecrets = apps.reduce((n, a, i) => n + (i % 4), 0);
    expect(secrets.rows).toHaveLength(liveSecrets);
    expect(secrets.rows.find((r: Def) => r.id === 'a3')).toMatchObject({ liveSecrets: 3 });
    const input = { value: { secrets: secrets.rows, certApps: secrets.certApps, sps: sps }, params };
    const page = await transform(id, 'page', input);
    const exported = await transform(id, 'exportList', input);

    // Expected, computed directly.
    const reg = apps.flatMap((a, i) =>
      Array.from({ length: i % 4 }, (_, k) => ({ i, n: i % 4, life: LIFETIMES[(i + k) % 4]! })),
    );
    const veryLong = reg.filter((c) => c.life > 3650).length;
    const tooLong = reg.filter((c) => c.life > 365 && c.life <= 3650).length;
    const several = reg.filter((c) => c.life <= 365 && c.n > 1).length;
    const eligible = sps.filter((s, i) => i % 10 !== 0 && i % 50 !== 1);
    const spSecrets = eligible.flatMap((s) => s.passwordCredentials);
    const spLong = spSecrets.filter(
      (c) => Date.parse(c.endDateTime) - Date.parse(c.startDateTime) > 365 * DAY,
    ).length;
    const onSp = spSecrets.length + eligible.flatMap((s) => s.keyCredentials).length;
    const total = veryLong + tooLong + several + onSp;
    expect(page).toMatchObject({
      long: veryLong + tooLong + spLong,
      onServicePrincipals: onSp,
      several: apps.filter((_, i) => i % 4 > 1).length,
      secretOnly: apps.filter((_, i) => i % 4 > 0 && i % 5 !== 0).length,
      listCapped: true,
      listTotal: total,
    });
    expect(page.rows).toHaveLength(2000);
    expect(page.rows.every((r: Def) => r.severity === 'crit')).toBe(true);
    expect(page.rows[0]).toMatchObject({ finding: 'Practically never expires', object: 'App registration' });

    expect(exported.rows).toHaveLength(total);
    expect(unique(exported.rows, 'key')).toBe(true);
    const counts = (f: string) => exported.rows.filter((r: Def) => r.finding === f).length;
    expect([
      counts('Practically never expires'),
      counts('Longer than allowed'),
      counts('Several active secrets'),
    ]).toEqual([veryLong, tooLong, several]);
    const enterprise = exported.rows.filter((r: Def) => r.object === 'Enterprise app');
    expect(enterprise.filter((r: Def) => r.owner === 'Microsoft').length).toBe(
      eligible
        .filter((s) => s.appOwnerOrganizationId === MICROSOFT)
        .flatMap((s) => [...s.passwordCredentials, ...s.keyCredentials]).length,
    );
    expect(def(id).export.data).toBe('exportList.rows');
  });

  it('identity.app-credential-hygiene: a secret without a start date still counts; partial reads are flagged', async () => {
    const id = 'identity.app-credential-hygiene';
    const params = { maxDays: 365, finding: 'Any' };
    const app = {
      id: 'a-nostart',
      appId: 'app-nostart',
      displayName: 'No start',
      passwordCredentials: [
        { keyId: 'k1', displayName: 'one', endDateTime: at(100) },
        { keyId: 'k2', displayName: 'two', startDateTime: at(-10), endDateTime: at(100) },
      ],
    };
    const secrets = await transform(id, 'secrets', { value: { apps: [app] }, params });
    const page = await transform(id, 'page', {
      value: { secrets: secrets.rows, certApps: [], sps: [], partial: true },
      params,
    });
    expect(page.rows.map((r: Def) => [r.c.keyId, r.finding])).toEqual([
      ['k1', 'Several active secrets'],
      ['k2', 'Several active secrets'],
    ]);
    expect(page.partial).toBe(true);
    const owners = await transform('identity.apps-without-owners', 'report', {
      value: { apps: [], sps: [], org: ORG, partial: true },
    });
    expect(owners.partial).toBe(true);
  });

  it('identity.apps-without-owners: 20k ownerless registrations and enterprise apps each, high attention first', async () => {
    const out = await transform('identity.apps-without-owners', 'report', {
      value: { apps, sps, org: ORG },
      params: { kind: 'Both' },
    });
    const withCreds = apps.filter((_, i) => i % 4 > 0 || i % 5 === 0).length;
    const withPerms = apps.filter((_, i) => !(i % 4 > 0 || i % 5 === 0) && i % 6 === 0).length;
    const third = sps.filter(
      (s) => s.servicePrincipalType === 'Application' && s.appOwnerOrganizationId === OTHER,
    );
    expect(out).toMatchObject({
      registrations: 20_000,
      withAccess: withCreds + withPerms,
      enterprise: third.length,
    });
    expect(out.rows).toHaveLength(20_000 + third.length);
    expect(unique(out.rows, 'id')).toBe(true);
    expect(out.rows[0]).toMatchObject({ attention: 'high', reason: 'Live credentials' });
    const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    expect(
      out.rows.every(
        (r: Def, i: number) => i === 0 || order[out.rows[i - 1].attention]! <= order[r.attention]!,
      ),
    ).toBe(true);
    expect(out.rows.find((r: Def) => r.id === 's2')).toMatchObject({
      kind: 'Enterprise app',
      detail: 'Publisher 2',
    });
    expect(out.rows.find((r: Def) => r.id === 's6')).toMatchObject({ detail: 'Unverified publisher' });
  });
});

describe('users and role assignments at scale', { retry: 2 }, () => {
  it('identity.users-without-mfa: 50k registration records, admins first', async () => {
    const value = Array.from({ length: 50_000 }, (_, i) => ({
      id: `u${i}`,
      userDisplayName: `User ${String(49_999 - i).padStart(5, '0')}`,
      userPrincipalName: `u${i}@example.com`,
      isAdmin: i % 50 === 0,
      isSsprRegistered: i % 3 === 0,
      methodsRegistered: i % 3 === 0 ? ['email'] : [],
    }));
    // A record without a name can't be a sort key: it goes last in its group, the report still loads.
    value.push({ ...value[1]!, id: 'unnamed', userDisplayName: null as unknown as string });
    const out = await transform('identity.users-without-mfa', 'report', { value: { value } });
    expect(out.rows.at(-1).id).toBe('unnamed');
    expect(out).toMatchObject({ total: 50_001, admins: 1000, ssprOnly: 16_667 });
    expect(out.rows.slice(0, 1000).every((r: Def) => r.isAdmin)).toBe(true);
    expect(out.rows[0].userDisplayName < out.rows[1].userDisplayName).toBe(true);
  });

  // 10,000 disabled accounts that still hold licences (about 20,000 assignments) — far more than a 50,000-user tenant has.
  it('identity.disabled-users-with-licences: one row per user and licence, natively', async () => {
    const skus = Array.from({ length: 30 }, (_, i) => ({ skuId: `sku${i}`, skuPartNumber: `PART_${i}` }));
    const value = Array.from({ length: 10_000 }, (_, i) => {
      const n = 1 + (i % 3);
      const ids = Array.from({ length: n }, (_, k) => `sku${(i + k) % 30}`);
      return {
        id: `u${i}`,
        displayName: `User ${String(i).padStart(5, '0')}`,
        userPrincipalName: `u${i}@example.com`,
        onPremisesSyncEnabled: i % 2 === 0 ? true : null,
        assignedLicenses: ids.map((skuId) => ({ skuId, disabledPlans: [] })),
        licenseAssignmentStates: ids.map((skuId, k) => ({
          skuId,
          assignedByGroup: k === 1 ? `grp${i % 10}` : null,
          state: 'Active',
          error: 'None',
        })),
      };
    });
    const states = value.reduce((n, u) => n + u.licenseAssignmentStates.length, 0);
    const out = await transform('identity.disabled-users-with-licences', 'users', {
      value: { value },
      ds: { skus: { value: skus } },
      params: { assignment: 'Any' },
    });
    expect(out).toMatchObject({
      accounts: 10_000,
      licences: states,
      direct: states - value.filter((_, i) => i % 3 > 0).length,
    });
    expect(out.rows).toHaveLength(states);
    expect(unique(out.rows, 'key')).toBe(true);
    expect(out.rows[0]).toMatchObject({
      displayName: 'User 00000',
      source: 'Synced',
      sku: 'PART_0',
      assignment: 'Direct',
    });
    expect(out.chart).toHaveLength(6);
    expect(out.chart[0].seats).toBeGreaterThanOrEqual(out.chart[5].seats);
  });

  // The enterprise tenant's size (1,500 active, 750 eligible; users, groups and apps). Roles, kinds and schedule
  // instances are keyed lookups now, but the transform still builds one row object per assignment (backlog).
  it('identity.privileged-role-assignments: 2,250 assignments resolved by keyed lookups', async () => {
    const definitions = Array.from({ length: 100 }, (_, i) => ({
      id: `def${i}`,
      templateId: `tpl${i}`,
      displayName: i === 0 ? 'Global Administrator' : `Role ${i}`,
      isPrivileged: i % 3 === 0,
    }));
    // Graph's expanded holder: its id and @odata.type (a group in a role response may omit securityEnabled).
    const principal = (i: number) =>
      i % 3 === 1
        ? { '@odata.type': '#microsoft.graph.group', id: `p${i}`, displayName: `Group ${i}` }
        : i % 3 === 2
          ? {
              '@odata.type': '#microsoft.graph.servicePrincipal',
              id: `p${i}`,
              displayName: `App ${i}`,
              appId: `app${i}`,
            }
          : {
              '@odata.type': '#microsoft.graph.user',
              id: `p${i}`,
              displayName: `Person ${i}`,
              userPrincipalName: `p${i}@example.com`,
              accountEnabled: i % 11 !== 0,
              onPremisesSyncEnabled: i % 4 === 0,
              userType: 'Member',
              assignedLicenses: [],
            };
    const assignment = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `a${i}`,
      roleDefinitionId: i % 2 ? `def${i % 100}` : `tpl${i % 100}`,
      principalId: `p${i}`,
      directoryScopeId: '/',
      principal: principal(i),
      ...extra,
    });
    const value = {
      definitions: { value: definitions },
      active: { value: Array.from({ length: 1500 }, (_, i) => assignment(i)) },
      eligible: {
        value: Array.from({ length: 750 }, (_, i) =>
          assignment(i + 1500, { startDateTime: NOW, endDateTime: null, memberType: 'Direct' }),
        ),
      },
      instances: {
        value: Array.from({ length: 1500 }, (_, i) => ({
          id: `inst${i}`,
          roleAssignmentOriginId: `a${i}`,
          assignmentType: i % 5 === 0 ? 'Activated' : 'Assigned',
          memberType: 'Direct',
          startDateTime: NOW,
          endDateTime: i % 5 === 0 ? NOW : null,
        })),
      },
    };
    const out = await transform('identity.privileged-role-assignments', 'assignments', {
      value,
      params: { scope: 'All', assignment: 'Any', principal: 'Any' },
    });
    expect(out.rows).toHaveLength(2250);
    expect(out.rows.filter((r: Def) => r.assignment === 'Activated')).toHaveLength(300);
    expect(out.rows.filter((r: Def) => r.assignment === 'Standing')).toHaveLength(1200);
    expect(out.rows.every((r: Def) => !r.role.startsWith('def') && !r.role.startsWith('tpl'))).toBe(true);
    expect(out.globalAdmins).toBe(0); // the built-in id isn't among the synthetic definitions
    expect(out.rows.find((r: Def) => r.principalId === 'p1')).toMatchObject({ principalType: 'Group' });
    expect(out.rows.find((r: Def) => r.principalId === 'p2')).toMatchObject({
      principalType: 'Service principal',
      findings: [],
    });
    expect(out.rows.find((r: Def) => r.principalId === 'p0')).toMatchObject({
      role: 'Global Administrator',
      privileged: true,
    });
  });
});
