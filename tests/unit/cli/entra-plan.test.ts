import { randomUUID } from 'node:crypto';
import { AUTOMATION_GRAPH_ROLES, RESOURCES, type ResourceKey } from '@adminforge/cli/src/provision/catalog';
import { appNames, buildDesiredEntra, groupNames } from '@adminforge/cli/src/provision/entra-desired';
import {
  diffApplication,
  mergeApplicationBody,
  planEntra,
  storedSecretIsLive,
} from '@adminforge/cli/src/provision/entra-plan';
import type {
  DesiredEntra,
  EntraOp,
  EntraState,
  GraphApplication,
  ProvisionSettings,
  ResourceServicePrincipal,
} from '@adminforge/cli/src/provision/model';

const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
  subscriptionId: randomUUID(),
};
const NOW = new Date('2026-10-15T00:00:00Z');

function resource(key: ResourceKey, scopes: string[], roles: string[] = []): ResourceServicePrincipal {
  return {
    id: randomUUID(),
    appId: RESOURCES[key].appId,
    oauth2PermissionScopes: scopes.map((value) => ({ id: randomUUID(), value, isEnabled: true })),
    appRoles: roles.map((value) => ({
      id: randomUUID(),
      value,
      allowedMemberTypes: ['Application'],
      isEnabled: true,
    })),
  };
}

const ALL_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'User.Read.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'Directory.Read.All',
  'AuditLog.Read.All',
  'Reports.Read.All',
  'Policy.Read.All',
  'RoleManagement.Read.Directory',
  'RoleEligibilitySchedule.Read.Directory',
  'RoleAssignmentSchedule.Read.Directory',
  'UserAuthenticationMethod.Read.All',
  'Application.Read.All',
  'DeviceManagementManagedDevices.Read.All',
  'DeviceManagementConfiguration.Read.All',
  'DeviceManagementApps.Read.All',
  'ServiceHealth.Read.All',
  'ServiceMessage.Read.All',
  'Organization.Read.All',
  'SecurityIncident.Read.All',
  'SecurityAlert.Read.All',
  'IdentityRiskyUser.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'User.ReadWrite.All',
  'User.EnableDisableAccount.All',
  'User.RevokeSessions.All',
  'Group.ReadWrite.All',
  'GroupMember.ReadWrite.All',
  'UserAuthenticationMethod.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
  'RoleAssignmentSchedule.ReadWrite.Directory',
  'Application.ReadWrite.All',
  'Policy.ReadWrite.ConditionalAccess',
  'DeviceManagementManagedDevices.ReadWrite.All',
  'DeviceManagementManagedDevices.PrivilegedOperations.All',
  'Mail.Send',
  'Directory.ReadWrite.All',
];

const resources = () => ({
  graph: resource('graph', ALL_SCOPES, [...AUTOMATION_GRAPH_ROLES]),
  arm: resource('arm', ['user_impersonation']),
  logAnalytics: resource('logAnalytics', ['Data.Read']),
});

const emptyState = (r: EntraState['resources']): EntraState => ({
  resources: r,
  apps: {},
  sps: {},
  grants: {},
  assignedTo: {},
  appPermissions: {},
  groups: {},
  arm: { assignments: [] },
  env: {},
});

/** Builds the fetched state that exactly matches `desired` (what Graph returns after a successful run). */
function convergedState(desired: DesiredEntra, r: EntraState['resources']): EntraState {
  const state = emptyState(r);
  for (const app of desired.apps) {
    const secret = `${app.key}-secret-value`;
    const a: GraphApplication = {
      id: randomUUID(),
      appId: randomUUID(),
      ...app.body,
      passwordCredentials: [
        { keyId: randomUUID(), hint: secret.slice(0, 3), endDateTime: '2027-04-01T00:00:00Z' },
      ],
    };
    state.apps[app.key] = a;
    state.sps[app.key] = { id: randomUUID(), appId: a.appId, ...app.sp };
    state.env[app.env.clientId] = a.appId;
    state.env[app.env.secret] = secret;
    state.grants[app.key] = app.grants.map((g) => ({
      id: randomUUID(),
      clientId: state.sps[app.key]!.id,
      resourceId: r[g.resource]!.id,
      consentType: 'AllPrincipals',
      scope: ` ${g.scopes.join(' ')} `,
    }));
    state.appPermissions[app.key] = app.appPermissions.flatMap((p) =>
      p.roles.map((role) => ({
        id: randomUUID(),
        principalId: state.sps[app.key]!.id,
        resourceId: r[p.resource]!.id,
        appRoleId: role.id,
      })),
    );
  }
  for (const g of desired.groups)
    state.groups[g.role] = { id: randomUUID(), uniqueName: g.uniqueName, ...g.body };
  for (const a of desired.groupAssignments)
    (state.assignedTo[a.app] ??= []).push({
      id: randomUUID(),
      principalId: state.groups[a.group]!.id,
      resourceId: state.sps[a.app]!.id,
      appRoleId: a.appRoleId,
    });
  state.arm.assignments = [
    {
      id: 'x',
      name: 'y',
      properties: {
        principalId: state.sps.automation!.id,
        roleDefinitionId: desired.arm!.roleDefinitionId.toUpperCase(),
        scope: desired.arm!.scope,
      },
    },
  ];
  return state;
}

const actions = (ops: EntraOp[]) => [...new Set(ops.map((o) => o.action))];

describe('buildDesiredEntra', () => {
  const desired = buildDesiredEntra(settings, resources());

  it('names apps and groups from the label', () => {
    expect(appNames('test', 'read')).toEqual({
      displayName: 'AdminForge Read [test]',
      uniqueName: 'adminforge-read-test',
    });
    expect(groupNames('test', 'Portal.Operator')).toEqual({
      displayName: 'SG-AdminForge-test-Portal.Operator',
      uniqueName: 'sg-adminforge-test-portal-operator',
    });
  });

  it('configures the Read app: single tenant, callback, no implicit grant, five deterministic roles, ID-token claims', () => {
    const read = desired.apps.find((a) => a.key === 'read')!;
    expect(read.body.signInAudience).toBe('AzureADMyOrg');
    expect(read.body.web.redirectUris).toEqual([
      'http://localhost:5173/auth/callback',
      'http://localhost:5173/auth/signed-out',
    ]);
    expect(read.body.web.implicitGrantSettings).toEqual({
      enableAccessTokenIssuance: false,
      enableIdTokenIssuance: false,
    });
    expect(read.body.appRoles.map((r) => r.value)).toEqual([
      'Portal.Reader',
      'Portal.Operator',
      'Playbook.Author',
      'Playbook.Approver',
      'Portal.Admin',
    ]);
    expect(buildDesiredEntra(settings, resources()).apps[0]!.body.appRoles.map((r) => r.id)).toEqual(
      read.body.appRoles.map((r) => r.id),
    );
    expect(read.body.optionalClaims.idToken.map((c) => c.name)).toEqual(['acrs', 'login_hint', 'acct']);
    expect(read.sp.appRoleAssignmentRequired).toBe(true);
    expect(read.grants.map((g) => g.resource)).toEqual(['graph', 'arm', 'logAnalytics']);
  });

  it('keeps Directory.ReadWrite.All out of the Write app and points it at the ARM callback', () => {
    const write = desired.apps.find((a) => a.key === 'write')!;
    expect(write.body.web.redirectUris).toEqual(['http://localhost:5173/auth/arm/callback']);
    const graphScopes = write.grants.find((g) => g.resource === 'graph')!.scopes;
    expect(graphScopes).toContain('User.EnableDisableAccount.All');
    expect(graphScopes).not.toContain('Directory.ReadWrite.All');
    // Least privilege: scopes only some content needs come from that content, not the baseline.
    expect(graphScopes).not.toContain('Policy.ReadWrite.ConditionalAccess');
    expect(graphScopes).not.toContain('RoleManagement.ReadWrite.Directory');
  });

  it('gives the automation identity application permissions and no redirect URI', () => {
    const automation = desired.apps.find((a) => a.key === 'automation')!;
    expect(automation.body.web.redirectUris).toEqual([]);
    expect(automation.appPermissions[0]!.roles.map((r) => r.value)).toEqual([...AUTOMATION_GRAPH_ROLES]);
    expect(automation.body.requiredResourceAccess[0]!.resourceAccess.every((a) => a.type === 'Role')).toBe(
      true,
    );
    expect(desired.arm!.roleDefinitionId).toMatch(/\/roleDefinitions\/acdd72a7-3385-48ef-bd42-f606fba81ae7$/);
  });

  it('assigns each portal group its role on Read, and Operators to Write with default access', () => {
    expect(desired.groupAssignments.filter((a) => a.app === 'write')).toEqual([
      {
        group: 'Portal.Operator',
        app: 'write',
        appRoleId: '00000000-0000-0000-0000-000000000000',
        roleName: 'Default access',
      },
    ]);
  });

  it('skips (does not fail on) a missing licensed resource, unknown scopes, and a missing subscription', () => {
    const r = resources();
    r.graph.oauth2PermissionScopes = r.graph.oauth2PermissionScopes.filter((s) => s.value !== 'Mail.Send');
    const d = buildDesiredEntra({ ...settings, subscriptionId: undefined }, r);
    const titles = d.skipped.map((s) => s.title);
    expect(titles).toContain('AdminForge Read [test] → Office 365 Exchange Online: Exchange.Manage');
    expect(titles).toContain('AdminForge Write [test] → Microsoft Graph: Mail.Send');
    expect(d.arm).toBeUndefined();
    expect(d.skipped.find((s) => s.section === 'Azure RBAC')!.reason).toMatch(/AF_SUBSCRIPTION_ID/);
  });

  it('includes Exchange.Manage when Exchange Online is present', () => {
    const d = buildDesiredEntra(settings, {
      ...resources(),
      exchange: resource('exchange', ['Exchange.Manage']),
    });
    expect(d.apps.find((a) => a.key === 'read')!.grants.map((g) => g.resource)).toContain('exchange');
    expect(d.skipped).toEqual([]);
  });
});

describe('planEntra', () => {
  const r = resources();
  const desired = buildDesiredEntra(settings, r);

  it('plans a create for every object in an empty tenant, in dependency order', () => {
    const ops = planEntra(desired, emptyState(r), NOW);
    expect(actions(ops.filter((o) => o.action !== 'skip'))).toEqual(['create']);
    const sections = ops.map((o) => o.section);
    expect(sections.indexOf('Applications')).toBeLessThan(sections.indexOf('Service principals'));
    expect(sections.lastIndexOf('Service principals')).toBeLessThan(sections.indexOf('Local credentials'));
    expect(sections.lastIndexOf('Groups')).toBeLessThan(sections.indexOf('Consent grants'));
    expect(ops.filter((o) => o.kind === 'appRoleAssignment')).toHaveLength(6 + AUTOMATION_GRAPH_ROLES.length);
    expect(ops.filter((o) => o.kind === 'secret')).toHaveLength(3);
  });

  it('is all no-op once the tenant matches (idempotent)', () => {
    const ops = planEntra(desired, convergedState(desired, r), NOW);
    expect(ops.filter((o) => o.action !== 'noop' && o.action !== 'skip')).toEqual([]);
  });

  it('detects drift: redirect URI, grant scopes, assignment-required, a removed role assignment', () => {
    const state = convergedState(desired, r);
    state.apps.read!.web = {
      ...state.apps.read!.web!,
      redirectUris: ['http://localhost:9999/auth/callback'],
    };
    state.grants.write![0]!.scope = 'openid Directory.ReadWrite.All';
    state.sps.read!.appRoleAssignmentRequired = false;
    state.appPermissions.automation!.pop();
    const changed = planEntra(desired, state, NOW).filter(
      (o) => o.action === 'update' || o.action === 'create',
    );
    expect(changed.map((o) => `${o.action} ${o.kind} ${o.title}`)).toEqual([
      'update application AdminForge Read [test]',
      'update servicePrincipal AdminForge Read [test]',
      'update grant AdminForge Write [test] → Microsoft Graph',
      'create appRoleAssignment AdminForge Automation [test] → Microsoft Graph: IdentityRiskyUser.Read.All',
    ]);
    expect(changed[0]!.changes).toEqual(['redirectUris']);
    expect(changed[2]!.changes).toContain('-Directory.ReadWrite.All');
    expect(changed[2]!.changes).toContain('+Mail.Send');
  });

  it('creates a new secret when the stored one is missing, foreign, or no longer live', () => {
    const secretOp = (s: EntraState) =>
      planEntra(desired, s, NOW).find((o) => o.kind === 'secret' && o.app === 'read')!;
    const base = () => convergedState(desired, r);

    expect(secretOp(base()).action).toBe('noop');
    const missing = base();
    delete missing.env.AF_READ_CLIENT_SECRET;
    expect(secretOp(missing)).toMatchObject({ action: 'create', changes: ['not in env file'] });
    const foreign = base();
    foreign.env.AF_READ_CLIENT_ID = randomUUID();
    expect(secretOp(foreign)).toMatchObject({
      action: 'create',
      changes: ['env file secret belongs to a different client id'],
    });
    const expired = base();
    expired.apps.read!.passwordCredentials![0]!.endDateTime = '2026-01-01T00:00:00Z';
    expect(secretOp(expired).action).toBe('create');
  });

  it('skips the Azure role assignment (with the reason) when ARM cannot be read', () => {
    const state = convergedState(desired, r);
    state.arm = { assignments: [], error: '403 AuthorizationFailed: no' };
    expect(planEntra(desired, state, NOW).find((o) => o.section === 'Azure RBAC')).toMatchObject({
      action: 'skip',
      changes: ['403 AuthorizationFailed: no'],
    });
  });
});

describe('application diff helpers', () => {
  const desired = buildDesiredEntra(settings, resources()).apps[0]!.body;

  it('ignores ordering and null-vs-default differences', () => {
    const current: GraphApplication = {
      id: 'i',
      appId: 'a',
      ...desired,
      groupMembershipClaims: 'None',
      requiredResourceAccess: [...desired.requiredResourceAccess].reverse(),
    };
    expect(diffApplication(desired, current)).toEqual([]);
  });

  it('keeps app roles that AdminForge does not manage when updating', () => {
    const foreign = {
      id: randomUUID(),
      value: 'Custom.Role',
      displayName: 'c',
      description: 'c',
      allowedMemberTypes: ['User'],
      isEnabled: true,
    };
    const merged = mergeApplicationBody(desired, {
      id: 'i',
      appId: 'a',
      appRoles: [...desired.appRoles, foreign],
    });
    expect(merged.appRoles).toHaveLength(desired.appRoles.length + 1);
    expect(merged.appRoles.at(-1)).toEqual(foreign);
  });

  it('matches stored secrets by Graph hint and expiry', () => {
    const app: GraphApplication = {
      id: 'i',
      appId: 'a',
      passwordCredentials: [{ keyId: 'k', hint: 'abc', endDateTime: '2027-01-01T00:00:00Z' }],
    };
    expect(storedSecretIsLive(app, 'abcdef', NOW)).toBe(true);
    expect(storedSecretIsLive(app, 'xyzdef', NOW)).toBe(false);
    expect(storedSecretIsLive(app, undefined, NOW)).toBe(false);
  });
});

describe('buildDesiredEntra with content-declared scopes', () => {
  it('adds content scopes to the right app and read-only scopes of write playbooks to the Read app', () => {
    const r = {
      graph: resource(
        'graph',
        [...ALL_SCOPES, 'SecurityEvents.Read.All', 'Group.Create'],
        [...AUTOMATION_GRAPH_ROLES, 'ThreatHunting.Read.All'],
      ),
      arm: resource('arm', ['user_impersonation']),
      logAnalytics: resource('logAnalytics', ['Data.Read']),
    };
    const desired = buildDesiredEntra(settings, r, {
      read: { graph: ['SecurityEvents.Read.All'] },
      write: { graph: ['Group.Create', 'AuditLog.Read.All'] },
      automation: { graph: ['ThreatHunting.Read.All'] },
    });
    const grant = (key: string) =>
      desired.apps.find((a) => a.key === key)!.grants.find((g) => g.resource === 'graph')?.scopes ?? [];
    expect(grant('read')).toEqual(expect.arrayContaining(['SecurityEvents.Read.All', 'AuditLog.Read.All']));
    expect(grant('read')).not.toContain('Group.Create');
    expect(grant('write')).toEqual(expect.arrayContaining(['Group.Create', 'AuditLog.Read.All']));
    expect(JSON.stringify(desired.apps.find((a) => a.key === 'automation')!.appPermissions)).toContain(
      'ThreatHunting.Read.All',
    );
    expect(desired.skipped.filter((x) => /SecurityEvents|Group\.Create|ThreatHunting/.test(x.title))).toEqual(
      [],
    );
  });

  it('skips content scopes for unlicensed workloads instead of failing', () => {
    const desired = buildDesiredEntra(settings, resources(), {
      read: { exchange: ['Exchange.Manage'], teams: ['user_impersonation'] },
    });
    expect(desired.skipped.some((x) => /Exchange/.test(x.title))).toBe(true);
    expect(desired.skipped.some((x) => /Teams/.test(x.title))).toBe(true);
  });
});

describe('extra redirect base URLs', () => {
  it('registers callback, signed-out and arm callback for every base', () => {
    const desired = buildDesiredEntra({ ...settings, extraBaseUrls: ['http://localhost:3300'] }, resources());
    const uris = (key: string) => desired.apps.find((a) => a.key === key)!.body.web!.redirectUris;
    expect(uris('read')).toEqual([
      'http://localhost:5173/auth/callback',
      'http://localhost:5173/auth/signed-out',
      'http://localhost:3300/auth/callback',
      'http://localhost:3300/auth/signed-out',
    ]);
    expect(uris('write')).toEqual([
      'http://localhost:5173/auth/arm/callback',
      'http://localhost:3300/auth/arm/callback',
    ]);
  });
});
