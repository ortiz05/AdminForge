import { randomUUID } from 'node:crypto';
import type { CliContext } from '@adminforge/cli/src/provision/clients';
import { provisionEntra, provisionStatus } from '@adminforge/cli/src/commands/provision';
import { AUTOMATION_GRAPH_ROLES, RESOURCES, type ResourceKey } from '@adminforge/cli/src/provision/catalog';
import { buildDesiredEntra } from '@adminforge/cli/src/provision/entra-desired';
import type {
  DesiredEntra,
  EntraState,
  GraphApplication,
  ProvisionSettings,
  ResourceServicePrincipal,
} from '@adminforge/cli/src/provision/model';
import { findUnexpected, unexpectedFailures } from '@adminforge/cli/src/provision/unexpected';
import { createFakeCloud } from './fake-cloud';

// `provision status` fails on privilege that provisioning did not grant (extra assignments, permissions, consent,
// owners, credentials, public-client surface, Azure roles) and prints names and counts only.
const SUB = randomUUID();
const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
  subscriptionId: SUB,
};
const NOW = new Date('2026-10-15T00:00:00Z');

function resource(key: ResourceKey, scopes: string[], roles: string[] = []): ResourceServicePrincipal {
  return {
    id: randomUUID(),
    appId: RESOURCES[key].appId,
    oauth2PermissionScopes: scopes.map((value) => ({ id: randomUUID(), value, isEnabled: true })),
    appRoles: roles.map((value) => ({ id: randomUUID(), value, allowedMemberTypes: ['Application'] })),
  };
}
const r = {
  graph: resource(
    'graph',
    ['openid', 'profile', 'offline_access', 'User.Read', 'User.Read.All'],
    [...AUTOMATION_GRAPH_ROLES, 'Mail.Read'],
  ),
  arm: resource('arm', ['user_impersonation']),
  logAnalytics: resource('logAnalytics', ['Data.Read']),
};
const desired = buildDesiredEntra(settings, r);

/** Fetched state exactly as provisioning leaves it. */
function converged(d: DesiredEntra = desired): EntraState {
  const state: EntraState = {
    resources: r,
    apps: {},
    sps: {},
    grants: {},
    assignedTo: {},
    appPermissions: {},
    groups: {},
    arm: { assignments: [] },
    env: {},
    owners: {},
    provisionerSpId: randomUUID(),
  };
  for (const app of d.apps) {
    const a: GraphApplication = {
      id: randomUUID(),
      appId: randomUUID(),
      ...app.body,
      passwordCredentials: [{ keyId: randomUUID(), hint: 'abc', endDateTime: '2027-04-01T00:00:00Z' }],
      keyCredentials: [],
      identifierUris: [],
      api: { oauth2PermissionScopes: [] },
    };
    state.apps[app.key] = a;
    state.sps[app.key] = {
      id: randomUUID(),
      appId: a.appId,
      ...app.sp,
      passwordCredentials: [],
      keyCredentials: [],
    };
    state.owners![app.key] = { app: [], sp: [] };
    state.grants[app.key] = app.grants.map((g) => ({
      id: randomUUID(),
      clientId: state.sps[app.key]!.id,
      resourceId: r[g.resource as 'graph']!.id,
      consentType: 'AllPrincipals',
      scope: g.scopes.join(' '),
    }));
    state.appPermissions[app.key] = app.appPermissions.flatMap((p) =>
      p.roles.map((role) => ({
        id: randomUUID(),
        principalId: state.sps[app.key]!.id,
        resourceId: r[p.resource as 'graph']!.id,
        appRoleId: role.id,
      })),
    );
  }
  for (const g of d.groups) state.groups[g.role] = { id: randomUUID(), displayName: g.body.displayName };
  for (const a of d.groupAssignments)
    (state.assignedTo[a.app] ??= []).push({
      id: randomUUID(),
      principalId: state.groups[a.group]!.id,
      resourceId: state.sps[a.app]!.id,
      appRoleId: a.appRoleId,
      principalType: 'Group',
    });
  const roleDef = (guid: string) =>
    `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${guid}`;
  state.arm.assignments = [
    {
      id: 'a',
      name: 'a',
      properties: {
        principalId: state.sps.automation!.id,
        roleDefinitionId: roleDef('acdd72a7-3385-48ef-bd42-f606fba81ae7'),
        scope: `/subscriptions/${SUB}`,
      },
    },
    {
      // provision azure-test: Log Analytics Reader on its own workspace is expected.
      id: 'b',
      name: 'b',
      properties: {
        principalId: state.sps.automation!.id,
        roleDefinitionId: roleDef('73c42c96-874c-492b-b04d-ab87d138a893'),
        scope: `/subscriptions/${SUB}/resourceGroups/AF-Test-test/providers/Microsoft.OperationalInsights/workspaces/af-test-law-test`,
      },
    },
  ];
  return state;
}

const problemsOf = (state: EntraState, title: RegExp) =>
  findUnexpected(desired, state, NOW)
    .filter((c) => title.test(c.title))
    .flatMap((c) => c.problems);

describe('findUnexpected', () => {
  it('finds nothing in a tenant exactly as provisioned', () => {
    const checks = findUnexpected(desired, converged(), NOW);
    expect(checks.length).toBeGreaterThan(15);
    expect(unexpectedFailures(checks)).toEqual([]);
  });

  it('flags users, groups or apps assigned besides the portal groups (by type, without names)', () => {
    const s = converged();
    s.assignedTo.write!.push({
      id: randomUUID(),
      principalId: randomUUID(),
      resourceId: s.sps.write!.id,
      appRoleId: '00000000-0000-0000-0000-000000000000',
      principalType: 'User',
      principalDisplayName: 'Someone Example',
    });
    s.assignedTo.automation = [
      {
        id: randomUUID(),
        principalId: randomUUID(),
        resourceId: s.sps.automation!.id,
        appRoleId: randomUUID(),
        principalType: 'Group',
      },
    ];
    expect(problemsOf(s, /Write.*assigned/)).toEqual([
      '1 assignment besides the AdminForge portal groups (1 user)',
    ]);
    expect(problemsOf(s, /Automation.*assigned/)).toEqual([
      '1 assignment besides the AdminForge portal groups (1 group)',
    ]);
    expect(JSON.stringify(findUnexpected(desired, s, NOW))).not.toContain('Someone Example');
  });

  it('flags application permissions provisioning did not grant, by permission name', () => {
    const s = converged();
    const mail = r.graph.appRoles.find((x) => x.value === 'Mail.Read')!;
    s.appPermissions.automation!.push({
      id: randomUUID(),
      principalId: s.sps.automation!.id,
      resourceId: r.graph.id,
      appRoleId: mail.id,
    });
    s.appPermissions.read = [
      { id: randomUUID(), principalId: s.sps.read!.id, resourceId: randomUUID(), appRoleId: randomUUID() },
    ];
    expect(problemsOf(s, /Automation.*application permissions/)).toEqual([
      '1 application permission provisioning did not grant — Microsoft Graph: Mail.Read',
    ]);
    expect(problemsOf(s, /Read.*application permissions/)).toEqual([
      '1 application permission provisioning did not grant — a permission on another resource',
    ]);
  });

  it('flags per-user consent and tenant-wide grants on other resources', () => {
    const s = converged();
    s.grants.read!.push(
      {
        id: randomUUID(),
        clientId: s.sps.read!.id,
        resourceId: r.graph.id,
        consentType: 'Principal',
        principalId: randomUUID(),
        scope: 'Mail.Read Files.Read',
      },
      {
        id: randomUUID(),
        clientId: s.sps.read!.id,
        resourceId: randomUUID(),
        consentType: 'AllPrincipals',
        scope: 'x',
      },
    );
    expect(problemsOf(s, /Read.*consent/)).toEqual([
      '1 per-user consent grant (2 scopes)',
      '1 tenant-wide grant on resources provisioning does not grant — another resource',
    ]);
    s.grants.automation = [
      {
        id: randomUUID(),
        clientId: s.sps.automation!.id,
        resourceId: r.graph.id,
        consentType: 'AllPrincipals',
        scope: 'User.Read',
      },
    ];
    expect(problemsOf(s, /Automation.*consent/)).toHaveLength(1);
  });

  it('flags owners of the apps and service principals, telling the provisioner apart', () => {
    const s = converged();
    s.owners!.automation = { app: [s.provisionerSpId!, randomUUID()], sp: [randomUUID()] };
    expect(problemsOf(s, /Automation.*owners/)).toEqual([
      'app registration owned by the provisioner identity and 1 other owner',
      'service principal owned by 1 other owner',
    ]);
  });

  it('flags extra client secrets, certificates and service-principal credentials', () => {
    const s = converged();
    s.apps.read!.passwordCredentials!.push({ keyId: randomUUID(), endDateTime: '2026-01-01T00:00:00Z' });
    s.apps.write!.keyCredentials = [{ keyId: randomUUID(), customKeyIdentifier: 'AAAA' }];
    s.sps.automation!.passwordCredentials = [{ keyId: randomUUID() }];
    expect(problemsOf(s, /Read.*credentials/)).toEqual([
      '2 client secrets (expected 1)',
      '1 of them expired',
    ]);
    expect(problemsOf(s, /Write.*credentials/)).toEqual(['1 certificate (expected none)']);
    expect(problemsOf(s, /Automation.*credentials/)).toEqual([
      'service principal holds 1 credential (expected none)',
    ]);
  });

  it('flags public-client flows, public-client/SPA redirect URIs, identifier URIs and exposed scopes', () => {
    const s = converged();
    Object.assign(s.apps.write!, {
      isFallbackPublicClient: true,
      publicClient: { redirectUris: ['http://localhost:1234'] },
      spa: { redirectUris: ['https://app.example.com'] },
      identifierUris: ['api://example'],
      api: { oauth2PermissionScopes: [{ id: randomUUID(), value: 'access' }] },
    });
    expect(problemsOf(s, /Write.*sign-in surface/)).toEqual([
      'public client flows allowed (isFallbackPublicClient)',
      '1 public-client redirect URI',
      '1 SPA redirect URI',
      '1 identifier URI',
      '1 exposed API scope',
    ]);
  });

  it('flags Azure roles beyond Reader on the subscription (+ Log Analytics Reader in AF-Test-<label>)', () => {
    const s = converged();
    s.arm.assignments.push(
      {
        id: 'c',
        name: 'c',
        properties: {
          principalId: s.sps.automation!.id,
          roleDefinitionId:
            '/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
          scope: `/subscriptions/${SUB}/resourceGroups/rg-other`,
        },
      },
      {
        id: 'd',
        name: 'd',
        properties: {
          principalId: s.sps.automation!.id,
          roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${randomUUID()}`,
          scope: '/providers/Microsoft.Management/managementGroups/root',
        },
      },
    );
    const problems = problemsOf(s, /Azure role/);
    expect(problems).toEqual([
      '2 role assignments provisioning did not make — Owner at resource group, another role at above the subscription',
    ]);
    expect(problems.join(' ')).not.toContain(SUB);
  });

  it('reports an unreadable ARM as a warning, not a failure', () => {
    const s = converged();
    s.arm.error = '403 AuthorizationFailed';
    const check = findUnexpected(desired, s, NOW).find((c) => /Azure role/.test(c.title))!;
    expect(check).toMatchObject({ problems: [], unknown: 'could not read Azure role assignments' });
  });
});

describe('provision status with unexpected privilege (fake Graph/ARM)', () => {
  it('fails, says what it found by name and count, and prints no object ids', async () => {
    const tenant = randomUUID();
    const provisioner = { clientId: randomUUID(), secret: 'provisioner-secret' };
    const cloud = createFakeCloud({ tenantId: tenant, provisioner });
    const env: Record<string, string | undefined> = {
      AF_TENANT_ID: tenant,
      AF_PROVISIONER_CLIENT_ID: provisioner.clientId,
      AF_PROVISIONER_CLIENT_SECRET: provisioner.secret,
      AF_SUBSCRIPTION_ID: randomUUID(),
      AF_ENV_LABEL: 'test',
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
    await provisionEntra(ctx);
    lines.length = 0;
    expect((await provisionStatus(ctx)).failures.filter((f) => /owners|assigned/.test(f))).toEqual([]);

    const write = cloud.apps.find((a) => a.uniqueName === 'adminforge-write-test')!;
    const writeSp = cloud.sps.find((s) => s.appId === write.appId)!;
    const intruder = randomUUID();
    cloud.owners.set(write.id, [intruder]);
    cloud.assignments.push({
      id: randomUUID(),
      principalId: intruder,
      resourceId: writeSp.id,
      appRoleId: '00000000-0000-0000-0000-000000000000',
      principalType: 'User',
    });
    lines.length = 0;
    const status = await provisionStatus(ctx);
    expect(status.ok).toBe(false);
    expect(status.failures).toEqual(
      expect.arrayContaining([
        'AdminForge Write [test]: owners — app registration owned by 1 other owner',
        'AdminForge Write [test]: assigned users, groups and apps — 1 assignment besides the AdminForge portal groups (1 user)',
      ]),
    );
    const output = lines.join('\n');
    expect(output).toContain('Unexpected privilege');
    for (const id of [intruder, write.id, write.appId as string, writeSp.id])
      expect(output).not.toContain(id);
  });
});
