import { randomUUID } from 'node:crypto';
import { RESOURCES, type ResourceKey } from '@adminforge/cli/src/provision/catalog';
import { appCredential } from '@adminforge/cli/src/provision/clients';
import { appNames, buildDesiredEntra, envKeysFor } from '@adminforge/cli/src/provision/entra-desired';
import { fetchEntraState } from '@adminforge/cli/src/provision/entra-io';
import { planEntra } from '@adminforge/cli/src/provision/entra-plan';
import type { GraphClient } from '@adminforge/connectors';
import type {
  EntraState,
  ProvisionSettings,
  ResourceServicePrincipal,
} from '@adminforge/cli/src/provision/model';
import { provisionSettings } from '@adminforge/cli/src/provision/settings';
import { appFor, declaredScopes } from '@adminforge/cli/src/content/scopes';
import { Schedule, type LoadedDefinition } from '@adminforge/schemas';

// Named app identities (ADR-014): `provision entra` creates each one like the automation identity — its own app
// registration and service principal, a secret (or its certificate), and exactly the application permissions the
// schedules naming it declare, under the automation identity's ceilings. `validate --scopes` files those
// declarations under the identity.

const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
  identities: [{ name: 'reports-team' }],
};
const KEY = 'identity:reports-team' as const;

function resource(key: ResourceKey, roles: string[] = []): ResourceServicePrincipal {
  return {
    id: randomUUID(),
    appId: RESOURCES[key].appId,
    oauth2PermissionScopes: [],
    appRoles: roles.map((value) => ({
      id: randomUUID(),
      value,
      allowedMemberTypes: ['Application'],
      isEnabled: true,
    })),
  };
}
const resources = () => ({
  graph: resource('graph', ['User.Read.All', 'AuditLog.Read.All', 'User.ReadWrite.All']),
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

const scheduleDef = (identity: unknown) =>
  ({
    file: 'schedules/x.schedule.yaml',
    def: Schedule.parse({
      kind: 'schedule',
      id: 'reports.inactive-users-team',
      version: '1.0.0',
      title: 'Inactive users for the reports team',
      owner: 'reports-team',
      cron: '0 6 * * 1',
      identity,
      job: { kind: 'report', ref: 'identity.inactive-users', delivery: [{ type: 'file' }] },
      requires: { scopes: { graph: ['User.Read.All', 'AuditLog.Read.All'] } },
    }),
  }) as unknown as LoadedDefinition;

describe('provisioning named app identities', () => {
  it('names and keys: its own app registration and AF_IDENTITY_<NAME>_* keys', () => {
    expect(appNames('test', KEY)).toEqual({
      displayName: 'AdminForge Identity reports-team [test]',
      uniqueName: 'adminforge-identity-reports-team--test',
    });
    expect(envKeysFor(KEY)).toEqual({
      clientId: 'AF_IDENTITY_REPORTS_TEAM_CLIENT_ID',
      secret: 'AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET',
      cert: 'AF_IDENTITY_REPORTS_TEAM_CERT_PATH',
    });
  });

  it('a schedule naming the identity puts its permissions on that identity, not the automation identity', () => {
    expect(appFor(scheduleDef({ app: 'reports-team' }).def)).toBe(KEY);
    expect(appFor(scheduleDef('automation').def)).toBe('automation');
    const d = declaredScopes([scheduleDef({ app: 'reports-team' })]);
    expect([...(d.scopes[KEY]?.graph ?? [])].sort()).toEqual(['AuditLog.Read.All', 'User.Read.All']);
    expect(d.scopes.automation.graph).toBeUndefined();
  });

  it('desired state: an app-only app with exactly what its schedules declare; writes withheld like automation', () => {
    const desired = buildDesiredEntra(settings, resources(), {
      [KEY]: { graph: ['User.Read.All', 'User.ReadWrite.All'] },
    });
    const app = desired.apps.find((a) => a.key === KEY)!;
    expect(app).toMatchObject({
      uniqueName: 'adminforge-identity-reports-team--test',
      grants: [],
      sp: { appRoleAssignmentRequired: true },
      env: { clientId: 'AF_IDENTITY_REPORTS_TEAM_CLIENT_ID' },
    });
    expect(app.appPermissions.flatMap((p) => p.roles.map((r) => r.value))).toEqual(['User.Read.All']);
    expect(desired.skipped).toContainEqual(
      expect.objectContaining({
        section: 'App role assignments',
        title: 'reports-team → Microsoft Graph: User.ReadWrite.All',
      }),
    );
  });

  it('write, sensitive and tier-0 permissions need the identity’s own opt-in on top of the global one', () => {
    const r = resources();
    const ask = {
      [KEY]: {
        graph: ['User.Read.All', 'User.ReadWrite.All', 'Mail.Read', 'RoleManagement.ReadWrite.Directory'],
      },
    };
    const granted = (s: ProvisionSettings) =>
      buildDesiredEntra(s, r, ask)
        .apps.find((a) => a.key === KEY)!
        .appPermissions.flatMap((p) => p.roles.map((x) => x.value))
        .sort();
    const globalOnly = {
      ...settings,
      allowAutomationWrites: true,
      allowAutomationSensitiveReads: true,
      allowAppPrivileged: true,
    };
    // The global switches alone lift nothing for a named identity.
    expect(granted(globalOnly)).toEqual(['User.Read.All']);
    const skipped = buildDesiredEntra(globalOnly, r, ask).skipped.find((s) =>
      s.title.includes('User.ReadWrite.All'),
    );
    expect(skipped!.reason).toContain('AF_IDENTITY_REPORTS_TEAM_ALLOW_WRITE_PERMISSIONS=true');
    // Its own write opt-in: writes, but still no tier-0 permission without the tier-0 opt-ins.
    const writes = { ...globalOnly, identities: [{ name: 'reports-team', allowWrites: true }] };
    expect(granted(writes)).toEqual(['User.Read.All', 'User.ReadWrite.All']);
    // Its own opt-ins without the global ones: nothing more either.
    expect(
      granted({
        ...settings,
        identities: [
          { name: 'reports-team', allowWrites: true, allowSensitiveReads: true, allowPrivileged: true },
        ],
      }),
    ).toEqual(['User.Read.All']);
  });

  it('a tier-0 application permission needs AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS, also for the automation identity', () => {
    const r = { graph: resource('graph', ['RoleManagement.ReadWrite.Directory', 'User.ReadWrite.All']) };
    const ask = { automation: { graph: ['RoleManagement.ReadWrite.Directory', 'User.ReadWrite.All'] } };
    const d = buildDesiredEntra({ ...settings, allowAutomationWrites: true }, r, ask);
    const roles = d.apps
      .find((a) => a.key === 'automation')!
      .appPermissions.flatMap((p) => p.roles.map((x) => x.value));
    expect(roles).toContain('User.ReadWrite.All');
    expect(roles).not.toContain('RoleManagement.ReadWrite.Directory');
    expect(d.skipped.find((s) => s.title.includes('RoleManagement'))!.reason).toMatch(
      /AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true/,
    );
  });

  it('the plan creates the app, its service principal, a secret and its app role assignments', () => {
    const r = resources();
    const desired = buildDesiredEntra(settings, r, { [KEY]: { graph: ['User.Read.All'] } });
    const ops = planEntra(desired, emptyState(r), new Date('2026-10-15T00:00:00Z'));
    const mine = ops.filter((o) => o.title.includes('reports-team') || o.title.includes('REPORTS_TEAM'));
    expect(mine.map((o) => [o.kind, o.action])).toEqual(
      expect.arrayContaining([
        ['application', 'create'],
        ['servicePrincipal', 'create'],
        ['secret', 'create'],
        ['appRoleAssignment', 'create'],
      ]),
    );
  });

  it('settings: AF_SCHEDULE_IDENTITIES, refusing bad names; credentials read from the identity’s own keys', () => {
    const env = {
      AF_TENANT_ID: settings.tenantId,
      AF_SCHEDULE_IDENTITIES: 'reports-team',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '00000000-0000-4000-8000-00000000a001',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET: 'synthetic',
    };
    expect(provisionSettings(env).identities).toEqual([
      { name: 'reports-team', allowWrites: false, allowSensitiveReads: false, allowPrivileged: false },
    ]);
    expect(
      provisionSettings({ ...env, AF_IDENTITY_REPORTS_TEAM_ALLOW_WRITE_PERMISSIONS: 'true' }).identities![0],
    ).toMatchObject({ allowWrites: true });
    // "--" never occurs in a name, so the alternate key is unambiguous.
    expect(() => provisionSettings({ ...env, AF_SCHEDULE_IDENTITIES: 'ops--test' })).toThrow(
      /AF_SCHEDULE_IDENTITIES/,
    );
    expect(appNames('dev', 'identity:ops-test').uniqueName).not.toBe(
      appNames('test-dev', 'identity:ops').uniqueName,
    );
    expect(() => provisionSettings({ ...env, AF_SCHEDULE_IDENTITIES: 'Reports Team' })).toThrow(
      /AF_SCHEDULE_IDENTITIES/,
    );
    expect(appCredential({ env }, KEY)).toMatchObject({
      clientId: '00000000-0000-4000-8000-00000000a001',
      kind: 'secret',
    });
  });

  it('provision status finds this environment’s identity apps that are no longer configured', async () => {
    const r = resources();
    const desired = buildDesiredEntra(settings, r, {});
    const graph = {
      request: async () => ({ data: { value: [] } }),
      all: async ({ path, query }: { path: string; query?: Record<string, string> }) =>
        path === '/applications' && query?.$filter?.startsWith('startswith(displayName,')
          ? [
              // Still configured, another environment's, and one taken out of AF_SCHEDULE_IDENTITIES.
              {
                appId: 'a-1',
                displayName: 'AdminForge Identity reports-team [test]',
                uniqueName: 'adminforge-identity-reports-team--test',
              },
              {
                appId: 'a-2',
                displayName: 'AdminForge Identity old-team [prod]',
                uniqueName: 'adminforge-identity-old-team--prod',
              },
              {
                appId: 'a-3',
                displayName: 'AdminForge Identity old-team [test]',
                uniqueName: 'adminforge-identity-old-team--test',
              },
            ]
          : [],
    } as unknown as GraphClient;
    const state = await fetchEntraState(graph, undefined, desired, r, {});
    expect(state.retiredIdentities).toEqual([
      { displayName: 'AdminForge Identity old-team [test]', appId: 'a-3' },
    ]);
  });
});
