import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRIVILEGED_APP_FAMILIES,
  PRIVILEGED_APP_ROLES,
  PRIVILEGED_DELEGATED_SCOPES,
} from '@adminforge/cli/src/provision/privilege';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The permission reports rank critical what provisioning holds back as tier 0 (2026-10-22 review):
// identity.app-permissions and identity.app-registration-risks every application permission in PRIVILEGED_APP_ROLES
// and PRIVILEGED_APP_FAMILIES (whose regex they copy), identity.consent-grants every delegated scope in
// PRIVILEGED_DELEGATED_SCOPES and any RoleManagement.ReadWrite.*. The reports' real transforms run on one synthetic
// grant, app or consent per name. (The other direction — what the reports rank critical, provisioning holds back — is
// tests/unit/cli/app-only-ceilings.test.ts.)

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => definitions.find((d) => d.def.id === id)!.def;
const transform = (id: string, ds: string, scope: Record<string, unknown>) =>
  renderString(def(id).datasources[ds].transform, {
    now: '2026-10-22T12:00:00Z',
    user: {},
    env: {},
    params: {},
    ...scope,
  }) as Promise<Def>;

const ORG = '00000000-0000-4000-8000-0000000000aa';
const GRAPH = '00000003-0000-0000-c000-000000000000';
const FAMILY_NAMES = [
  'RoleManagement.ReadWrite.Exchange',
  'RoleManagementPolicy.ReadWrite.AzureADGroup',
  'Policy.ReadWrite.SecurityDefaults',
  'Policy.ReadWrite.CrossTenantAccess',
  'UserAuthenticationMethod.ReadWrite.All',
  'UserAuthMethod-TAP.ReadWrite.All',
  'UserAuthMethod-Phone.Delete.All',
  'LifecycleWorkflows.ReadWrite.All',
  'LifecycleWorkflows-Workflow.Activate',
  'AgentIdentityBlueprint.AddRemoveCreds.All',
  'TeamsAppInstallation.ReadWriteAndConsentForUser.All',
];
const TIER0_APP = [
  ...PRIVILEGED_APP_ROLES.filter((n) => n !== 'Directory.AccessAsUser.All'),
  ...FAMILY_NAMES,
];
const ORDINARY = ['User.Read.All', 'Reports.Read.All', 'Device.Read.All'];

describe('permission reports: critical means tier 0', () => {
  it('identity.app-permissions ranks every tier-0 application permission critical', async () => {
    const names = [...TIER0_APP, 'Mail.Send', ...ORDINARY];
    const list = await transform('identity.app-permissions', 'permissionList', {
      value: {
        grants: names.map((_, i) => ({
          id: `g${i}`,
          appRoleId: `r${i}`,
          principalId: 'sp0',
          principalDisplayName: 'App',
          resourceDisplayName: 'Microsoft Graph',
          createdDateTime: '2026-10-22T00:00:00Z',
        })),
        roles: Object.fromEntries(names.map((n, i) => [`r${i}`, n])),
        org: ORG,
        holders: [
          {
            id: 'sp0',
            appId: 'app0',
            servicePrincipalType: 'Application',
            appOwnerOrganizationId: ORG,
            verifiedPublisher: {},
            accountEnabled: true,
            displayName: 'App',
            tags: [],
          },
        ],
      },
      params: { tier: 'all', holder: 'Any' },
    });
    const tier = Object.fromEntries(list.rows.map((r: Def) => [r.permission, r.tier]));
    expect(TIER0_APP.filter((n) => tier[n] !== 'critical')).toEqual([]);
    expect([tier['Mail.Send'], ...ORDINARY.map((n) => tier[n])]).toEqual([
      'high',
      'medium',
      'medium',
      'medium',
    ]);
  });

  it('identity.app-registration-risks flags an app that requests any tier-0 application permission', async () => {
    const names = [...TIER0_APP, ...ORDINARY];
    const apps = names.map((n, i) => ({
      id: `a${i}`,
      appId: `app${i}`,
      displayName: n,
      signInAudience: 'AzureADMyOrg',
      createdDateTime: '2026-10-01T00:00:00Z',
      web: { redirectUris: [], implicitGrantSettings: {} },
      spa: { redirectUris: [] },
      publicClient: { redirectUris: [] },
      passwordCredentials: [],
      keyCredentials: [],
      requiredResourceAccess: [{ resourceAppId: GRAPH, resourceAccess: [{ id: `r${i}`, type: 'Role' }] }],
    }));
    const out = await transform('identity.app-registration-risks', 'appList', {
      value: { value: apps },
      ds: { graphApi: Object.fromEntries(names.map((n, i) => [`r${i}`, n])) },
      params: { severity: 'all' },
    });
    const flagged = new Set(
      out.rows.filter((r: Def) => r.criticalPermissions).map((r: Def) => r.displayName),
    );
    expect(TIER0_APP.filter((n) => !flagged.has(n))).toEqual([]);
    expect(ORDINARY.filter((n) => flagged.has(n))).toEqual([]);
  });

  it('identity.consent-grants ranks every tier-0 delegated scope critical', async () => {
    const scopes = [
      ...PRIVILEGED_DELEGATED_SCOPES,
      'RoleManagement.ReadWrite.Exchange',
      'Mail.Read',
      'User.Read',
    ];
    const list = await transform('identity.consent-grants', 'grantList', {
      value: {
        grants: scopes.map((s, i) => ({
          id: `cg${i}`,
          clientId: 'c0',
          resourceId: 'graph',
          principalId: null,
          consentType: 'AllPrincipals',
          scope: ` openid ${s}`,
        })),
        objects: [
          {
            id: 'graph',
            appId: GRAPH,
            displayName: 'Microsoft Graph',
            appOwnerOrganizationId: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
          },
          {
            id: 'c0',
            appId: 'app0',
            displayName: 'Client',
            appOwnerOrganizationId: ORG,
            verifiedPublisher: {},
          },
        ],
        org: ORG,
        truncated: false,
      },
      params: { consent: 'Any', risk: 'all' },
    });
    const tier = Object.fromEntries(list.rows.map((r: Def) => [r.sc.scopes.at(-1), r.sc.tier]));
    expect(scopes.slice(0, -2).filter((s) => tier[s] !== 'critical')).toEqual([]);
    expect([tier['Mail.Read'], tier['User.Read']]).toEqual(['high', 'low']);
  });

  it('copies PRIVILEGED_APP_FAMILIES word for word', () => {
    const want = PRIVILEGED_APP_FAMILIES.map((r) => r.source).join('|');
    expect(PRIVILEGED_APP_FAMILIES.every((r) => r.flags.includes('i'))).toBe(true);
    for (const [id, ds] of [
      ['identity.app-permissions', 'permissionList'],
      ['identity.app-registration-risks', 'appList'],
    ] as const) {
      const m = /\$criticalFamily := \/(.*)\/i;/.exec(def(id).datasources[ds].transform);
      expect(m?.[1], id).toBe(want);
    }
  });
});
