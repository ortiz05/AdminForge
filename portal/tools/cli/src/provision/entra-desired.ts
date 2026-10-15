import {
  AUTOMATION_GRAPH_ROLES,
  AZURE_READER_ROLE_ID,
  DEFAULT_ACCESS_ROLE_ID,
  ENTERPRISE_APP_TAG,
  OPTIONAL_RESOURCES,
  PORTAL_ROLES,
  READ_GRAPH_SCOPES,
  RESOURCES,
  WRITE_GRAPH_SCOPES,
  type PortalRole,
  type ResourceKey,
} from './catalog';
import { appRoleId } from './ids';
import type {
  AppKey,
  ApplicationBody,
  DesiredApp,
  DesiredEntra,
  DesiredGroup,
  EntraState,
  ProvisionSettings,
  RequiredResourceAccess,
  Skipped,
} from './model';

const APP_TITLES: Record<AppKey, string> = { read: 'Read', write: 'Write', automation: 'Automation' };

/** Display name and alternate key (uniqueName) of each app registration. */
export const appNames = (label: string, key: AppKey) => ({
  displayName: `AdminForge ${APP_TITLES[key]} [${label}]`,
  uniqueName: `adminforge-${key}-${label}`,
});

export const roleKebab = (role: string) => role.toLowerCase().replace(/\./g, '-');

/** Display name and alternate key of a portal role's security group. */
export const groupNames = (label: string, role: PortalRole) => ({
  displayName: `SG-AdminForge-${label}-${role}`,
  uniqueName: `sg-adminforge-${label}-${roleKebab(role)}`,
});

export const ENV_KEYS: Record<AppKey, { clientId: string; secret: string }> = {
  read: { clientId: 'AF_READ_CLIENT_ID', secret: 'AF_READ_CLIENT_SECRET' },
  write: { clientId: 'AF_WRITE_CLIENT_ID', secret: 'AF_WRITE_CLIENT_SECRET' },
  automation: { clientId: 'AF_AUTOMATION_CLIENT_ID', secret: 'AF_AUTOMATION_CLIENT_SECRET' },
};

type Resources = EntraState['resources'];

interface PermissionRequest {
  resource: ResourceKey;
  values: readonly string[];
  type: 'Scope' | 'Role';
}

/**
 * Resolves permission names to ids using each resource service principal. Missing resources (unlicensed
 * workloads) and unknown names are reported as skipped, never fatal.
 */
function resolvePermissions(app: string, requests: PermissionRequest[], resources: Resources, skipped: Skipped[]) {
  const rra: RequiredResourceAccess[] = [];
  const resolved: Array<{ resource: ResourceKey; type: 'Scope' | 'Role'; items: Array<{ value: string; id: string }> }> = [];
  for (const req of requests) {
    const sp = resources[req.resource];
    const resourceName = RESOURCES[req.resource].name;
    if (!sp) {
      const why = OPTIONAL_RESOURCES.has(req.resource)
        ? 'resource service principal not in this tenant (workload not licensed)'
        : 'resource service principal not found in this tenant';
      skipped.push({ section: 'Consent grants', title: `${app} → ${resourceName}: ${req.values.join(' ')}`, reason: why });
      continue;
    }
    const items: Array<{ value: string; id: string }> = [];
    for (const value of req.values) {
      const found =
        req.type === 'Scope'
          ? sp.oauth2PermissionScopes.find((s) => s.value === value && s.isEnabled !== false)
          : sp.appRoles.find((r) => r.value === value && r.isEnabled !== false && (r.allowedMemberTypes ?? ['Application']).includes('Application'));
      if (found) items.push({ value, id: found.id });
      else
        skipped.push({
          section: req.type === 'Scope' ? 'Consent grants' : 'App role assignments',
          title: `${app} → ${resourceName}: ${value}`,
          reason: `${req.type === 'Scope' ? 'delegated permission' : 'application permission'} not published by ${resourceName}`,
        });
    }
    if (!items.length) continue;
    resolved.push({ resource: req.resource, type: req.type, items });
    rra.push({ resourceAppId: RESOURCES[req.resource].appId, resourceAccess: items.map((i) => ({ id: i.id, type: req.type })) });
  }
  return { rra, resolved };
}

const NO_IMPLICIT = { enableAccessTokenIssuance: false, enableIdTokenIssuance: false };

function appBody(displayName: string, redirectUris: string[], rra: RequiredResourceAccess[], extra: Partial<ApplicationBody> = {}): ApplicationBody {
  return {
    displayName,
    signInAudience: 'AzureADMyOrg',
    groupMembershipClaims: 'None',
    web: { redirectUris, implicitGrantSettings: NO_IMPLICIT },
    appRoles: [],
    optionalClaims: { idToken: [], accessToken: [], saml2Token: [] },
    requiredResourceAccess: rra,
    ...extra,
  };
}

/** Pure: the full desired Entra/Azure state for one environment label. */
/** Permissions declared by content (`requires.scopes`), per app and service — see content/scopes.ts. */
export type ContentScopes = Partial<Record<'read' | 'write' | 'automation', Partial<Record<string, Iterable<string>>>>>;

const SERVICE_RESOURCE: Record<string, ResourceKey | undefined> = {
  graph: 'graph',
  exchange: 'exchange',
  teams: 'teams',
  sharepointAdmin: 'sharepoint',
};

const union = (...lists: Array<Iterable<string> | undefined>) => {
  const seen = new Map<string, string>();
  for (const list of lists) for (const v of list ?? []) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
};

/** Read-only scope names (`X.Read.Y`, `X.ReadBasic.Y`) — dry runs of write playbooks execute their reads with the Read app. */
const readOnly = (scopes: Iterable<string> | undefined) => [...(scopes ?? [])].filter((s) => /\.Read(Basic)?(\.|$)/.test(s) && !/ReadWrite/.test(s));

/**
 * Desired Entra objects. Each app's permissions = the baseline catalog ∪ what published content declares
 * (`requires.scopes`), so provisioning and `adminforge validate --scopes` stay in sync (least privilege, verified).
 */
export function buildDesiredEntra(settings: ProvisionSettings, resources: Resources, content: ContentScopes = {}): DesiredEntra {
  const { label, baseUrl } = settings;
  const skipped: Skipped[] = [];
  const apps: DesiredApp[] = [];

  const delegatedApp = (key: AppKey, graphScopes: readonly string[], redirectPath: string | string[], extra: Partial<ApplicationBody>, more: PermissionRequest[]) => {
    const names = appNames(label, key);
    const { rra, resolved } = resolvePermissions(
      names.displayName,
      [{ resource: 'graph', values: graphScopes, type: 'Scope' }, { resource: 'arm', values: ['user_impersonation'], type: 'Scope' }, ...more],
      resources,
      skipped,
    );
    apps.push({
      key,
      uniqueName: names.uniqueName,
      body: appBody(names.displayName, [baseUrl, ...(settings.extraBaseUrls ?? [])].flatMap((base) => [redirectPath].flat().map((path) => `${base}${path}`)), rra, extra),
      sp: { appRoleAssignmentRequired: true, tags: [ENTERPRISE_APP_TAG] },
      grants: resolved.map((r) => ({ resource: r.resource, scopes: r.items.map((i) => i.value) })),
      appPermissions: [],
      env: ENV_KEYS[key],
    });
  };

  const extra = (app: 'read' | 'write' | 'automation', type: 'Scope' | 'Role', exclude: string[] = []): PermissionRequest[] =>
    Object.entries(content[app] ?? {}).flatMap(([service, values]) => {
      const resource = SERVICE_RESOURCE[service];
      const list = [...(values ?? [])];
      return resource && resource !== 'graph' && !exclude.includes(service) && list.length ? [{ resource, values: list, type }] : [];
    });
  const mergeByResource = (requests: PermissionRequest[]): PermissionRequest[] => {
    const byKey = new Map<string, PermissionRequest>();
    for (const r of requests) {
      const k = `${r.resource}:${r.type}`;
      const prev = byKey.get(k);
      byKey.set(k, prev ? { ...prev, values: union(prev.values, r.values) } : r);
    }
    return [...byKey.values()];
  };

  delegatedApp(
    'read',
    union(READ_GRAPH_SCOPES, content.read?.graph, readOnly(content.write?.graph)),
    // The sign-out landing page doubles as the post_logout_redirect_uri, which must be registered.
    ['/auth/callback', '/auth/signed-out'],
    {
      appRoles: PORTAL_ROLES.map((r) => ({
        id: appRoleId(label, r.value),
        value: r.value,
        displayName: r.displayName,
        description: r.description,
        allowedMemberTypes: ['User'],
        isEnabled: true,
      })),
      optionalClaims: {
        idToken: [
          { name: 'acrs', source: null, essential: false, additionalProperties: [] },
          { name: 'login_hint', source: null, essential: false, additionalProperties: [] },
        ],
        accessToken: [],
        saml2Token: [],
      },
    },
    mergeByResource([
      { resource: 'logAnalytics', values: ['Data.Read'], type: 'Scope' },
      { resource: 'exchange', values: ['Exchange.Manage'], type: 'Scope' },
      ...extra('read', 'Scope'),
    ]),
  );

  delegatedApp(
    'write',
    union(WRITE_GRAPH_SCOPES, content.write?.graph),
    '/auth/arm/callback',
    {},
    mergeByResource([{ resource: 'exchange', values: ['Exchange.Manage'], type: 'Scope' }, ...extra('write', 'Scope')]),
  );

  {
    const names = appNames(label, 'automation');
    const { rra, resolved } = resolvePermissions(
      names.displayName,
      mergeByResource([{ resource: 'graph', values: union(AUTOMATION_GRAPH_ROLES, content.automation?.graph), type: 'Role' }, ...extra('automation', 'Role')]),
      resources,
      skipped,
    );
    apps.push({
      key: 'automation',
      uniqueName: names.uniqueName,
      body: appBody(names.displayName, [], rra),
      sp: { appRoleAssignmentRequired: false, tags: [ENTERPRISE_APP_TAG] },
      grants: [],
      appPermissions: resolved.map((r) => ({ resource: r.resource, roles: r.items })),
      env: ENV_KEYS.automation,
    });
  }

  const groups: DesiredGroup[] = PORTAL_ROLES.map((r) => {
    const names = groupNames(label, r.value);
    return {
      role: r.value,
      uniqueName: names.uniqueName,
      body: {
        displayName: names.displayName,
        description: `AdminForge [${label}] ${r.value}: ${r.description}`,
        mailEnabled: false,
        mailNickname: names.uniqueName,
        securityEnabled: true,
        groupTypes: [],
      },
    };
  });

  const groupAssignments = [
    ...PORTAL_ROLES.map((r) => ({ group: r.value, app: 'read' as const, appRoleId: appRoleId(label, r.value), roleName: r.value })),
    { group: 'Portal.Operator' as const, app: 'write' as const, appRoleId: DEFAULT_ACCESS_ROLE_ID, roleName: 'Default access' },
  ];

  let arm: DesiredEntra['arm'];
  if (settings.subscriptionId) {
    const scope = `/subscriptions/${settings.subscriptionId}`;
    arm = { scope, roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${AZURE_READER_ROLE_ID}`, roleName: 'Reader' };
  } else {
    skipped.push({ section: 'Azure RBAC', title: `${appNames(label, 'automation').displayName} → Reader on subscription`, reason: 'AF_SUBSCRIPTION_ID is not set' });
  }

  return { settings, apps, groups, groupAssignments, arm, skipped };
}
