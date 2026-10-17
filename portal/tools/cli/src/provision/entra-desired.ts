/**
 * The desired Entra state for one environment (`buildDesiredEntra`): the Read, Write and Automation app
 * registrations and their service principals, one security group per portal role, delegated consent grants,
 * application-permission assignments and the automation identity's Azure Reader role — named from AF_ENV_LABEL
 * (`appNames`, `groupNames`) and keyed by alternate keys so runs are idempotent.
 *
 * Permissions per app = the catalog baseline (provision/catalog.ts) ∪ what content declares (`requires.scopes`),
 * minus what a permission ceiling withholds (provision/privilege.ts, lifted only by the opt-ins in the env file).
 * `desiredPermissions` is the shared rule: `adminforge validate --scopes` (content/scopes.ts) uses it too, so
 * validation and provisioning agree on what is expected.
 *
 * Pure: settings + resource service principals (resolved by provision/entra-io.ts) + content scopes → desired state.
 * The first step of the desired → plan → apply → status pattern; provision/entra-plan.ts compares it with the tenant.
 */
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
import {
  isPrivilegedDelegatedScope,
  isReadOnlyPermission,
  isSensitiveReadAppRole,
  isWriteCapableDelegatedScope,
} from './privilege';
import { identityEnvPrefix } from '@adminforge/schemas';
import {
  identityAppKey,
  identityNameOf,
  isAppOnly,
  isIdentityApp,
  type AppKey,
  type ApplicationBody,
  type DesiredApp,
  type DesiredEntra,
  type DesiredGroup,
  type EntraState,
  type ProvisionSettings,
  type RequiredResourceAccess,
  type Skipped,
} from './model';

const APP_TITLES: Record<'read' | 'write' | 'automation', string> = {
  read: 'Read',
  write: 'Write',
  automation: 'Automation',
};

/**
 * Display name and alternate key (uniqueName) of each app registration: "AdminForge Read [dev]" / adminforge-read-dev,
 * and for a named app identity "AdminForge Identity reports-team [dev]" / adminforge-identity-reports-team--dev ("--"
 * never occurs in a name, so `ops-test` in `dev` and `ops` in `test-dev` can't share an app).
 */
export const appNames = (label: string, key: AppKey) =>
  isIdentityApp(key)
    ? {
        displayName: `AdminForge Identity ${identityNameOf(key)} [${label}]`,
        uniqueName: `adminforge-identity-${identityNameOf(key)}--${label}`,
      }
    : { displayName: `AdminForge ${APP_TITLES[key]} [${label}]`, uniqueName: `adminforge-${key}-${label}` };

export const roleKebab = (role: string) => role.toLowerCase().replace(/\./g, '-');

/** Display name and alternate key of a portal role's security group. */
export const groupNames = (label: string, role: PortalRole) => ({
  displayName: `SG-AdminForge-${label}-${role}`,
  uniqueName: `sg-adminforge-${label}-${roleKebab(role)}`,
});

export const ENV_KEYS: Record<'read' | 'write' | 'automation', { clientId: string; secret: string }> = {
  read: { clientId: 'AF_READ_CLIENT_ID', secret: 'AF_READ_CLIENT_SECRET' },
  write: { clientId: 'AF_WRITE_CLIENT_ID', secret: 'AF_WRITE_CLIENT_SECRET' },
  automation: { clientId: 'AF_AUTOMATION_CLIENT_ID', secret: 'AF_AUTOMATION_CLIENT_SECRET' },
};

/** The env keys of any app: the built-in three, or a named identity's AF_IDENTITY_<NAME>_CLIENT_ID / _CLIENT_SECRET. */
export function envKeysFor(key: AppKey): { clientId: string; secret: string; cert?: string } {
  if (!isIdentityApp(key))
    return key === 'automation' ? { ...ENV_KEYS.automation, cert: 'AF_AUTOMATION_CERT_PATH' } : ENV_KEYS[key];
  const prefix = identityEnvPrefix(identityNameOf(key));
  return { clientId: `${prefix}CLIENT_ID`, secret: `${prefix}CLIENT_SECRET`, cert: `${prefix}CERT_PATH` };
}

type Resources = EntraState['resources'];

export interface PermissionRequest {
  resource: ResourceKey;
  values: readonly string[];
  type: 'Scope' | 'Role';
}

/**
 * Resolves permission names to ids using each resource service principal. Missing resources (unlicensed
 * workloads) and unknown names are reported as skipped, never fatal.
 */
function resolvePermissions(
  app: string,
  requests: PermissionRequest[],
  resources: Resources,
  skipped: Skipped[],
) {
  const rra: RequiredResourceAccess[] = [];
  const resolved: Array<{
    resource: ResourceKey;
    type: 'Scope' | 'Role';
    items: Array<{ value: string; id: string }>;
  }> = [];
  for (const req of requests) {
    const sp = resources[req.resource];
    const resourceName = RESOURCES[req.resource].name;
    if (!sp) {
      const why = OPTIONAL_RESOURCES.has(req.resource)
        ? 'resource service principal not in this tenant (workload not licensed)'
        : 'resource service principal not found in this tenant';
      skipped.push({
        section: 'Consent grants',
        title: `${app} → ${resourceName}: ${req.values.join(' ')}`,
        reason: why,
      });
      continue;
    }
    const items: Array<{ value: string; id: string }> = [];
    for (const value of req.values) {
      const found =
        req.type === 'Scope'
          ? sp.oauth2PermissionScopes.find((s) => s.value === value && s.isEnabled !== false)
          : sp.appRoles.find(
              (r) =>
                r.value === value &&
                r.isEnabled !== false &&
                (r.allowedMemberTypes ?? ['Application']).includes('Application'),
            );
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
    rra.push({
      resourceAppId: RESOURCES[req.resource].appId,
      resourceAccess: items.map((i) => ({ id: i.id, type: req.type })),
    });
  }
  return { rra, resolved };
}

const NO_IMPLICIT = { enableAccessTokenIssuance: false, enableIdTokenIssuance: false };

function appBody(
  displayName: string,
  redirectUris: string[],
  rra: RequiredResourceAccess[],
  extra: Partial<ApplicationBody> = {},
): ApplicationBody {
  return {
    displayName,
    signInAudience: 'AzureADMyOrg',
    groupMembershipClaims: 'None',
    web: { redirectUris, implicitGrantSettings: NO_IMPLICIT },
    // Confidential web clients only: no public-client flows, no SPA (browser) redirect URIs.
    isFallbackPublicClient: false,
    publicClient: { redirectUris: [] },
    spa: { redirectUris: [] },
    appRoles: [],
    optionalClaims: { idToken: [], accessToken: [], saml2Token: [] },
    requiredResourceAccess: rra,
    ...extra,
  };
}

const idTokenClaims = (...names: string[]) =>
  names.map((name) => ({ name, source: null, essential: false, additionalProperties: [] }));

/** Application permissions that only read: the verb after the resource is Read or ReadBasic (User.Read.All). */
export const isReadOnlyAppRole = (value: string) => ['Read', 'ReadBasic'].includes(value.split('.')[1] ?? '');

/**
 * Application permissions that reach nothing until an administrator grants a specific site, list or file to the app
 * (`POST /sites/{id}/permissions`): Sites.Selected and its Lists/ListItems/Files `SelectedOperations` siblings. What
 * the app may do is set per resource by that grant, so provisioning may add them without the write opt-in; the grants
 * themselves stay a deliberate step (docs/operations.md › Synthetic transactions).
 */
export const isPerResourceAppRole = (value: string) =>
  /^Sites\.Selected$/i.test(value) || /^(Lists|ListItems|Files)\.SelectedOperations\.Selected$/i.test(value);

/** Permissions declared by content (`requires.scopes`), per app and service — see content/scopes.ts. */
export type ContentScopes = Partial<Record<AppKey, Partial<Record<string, Iterable<string>>>>>;

/** Content service key (content/scopes.ts) → resource. ARM and Log Analytics come from the baseline only. */
const SERVICE_RESOURCE: Record<string, ResourceKey | undefined> = {
  graph: 'graph',
  exchange: 'exchange',
  teams: 'teams',
  sharepointAdmin: 'sharepoint',
};

const union = (...lists: Array<Iterable<string> | undefined>) => {
  const seen = new Map<string, string>();
  for (const list of lists)
    for (const v of list ?? []) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
};

/** Read-only scope names (`X.Read.Y`, `X.ReadBasic.Y`) — dry runs of write playbooks execute their reads with the Read app. */
export const readOnly = (scopes: Iterable<string> | undefined) =>
  [...(scopes ?? [])].filter(isReadOnlyPermission);

const mergeByResource = (requests: PermissionRequest[]): PermissionRequest[] => {
  const byKey = new Map<string, PermissionRequest>();
  for (const r of requests) {
    const k = `${r.resource}:${r.type}`;
    const prev = byKey.get(k);
    byKey.set(
      k,
      prev ? { ...prev, values: union(prev.values, r.values) } : { ...r, values: union(r.values) },
    );
  }
  return [...byKey.values()];
};

/** Permissions every installation gets, whatever content declares (catalog.ts). */
export function baselinePermissions(): Record<AppKey, PermissionRequest[]> {
  return {
    read: [
      { resource: 'graph', values: READ_GRAPH_SCOPES, type: 'Scope' },
      { resource: 'arm', values: ['user_impersonation'], type: 'Scope' },
      { resource: 'logAnalytics', values: ['Data.Read'], type: 'Scope' },
      { resource: 'exchange', values: ['Exchange.Manage'], type: 'Scope' },
    ],
    write: [
      { resource: 'graph', values: WRITE_GRAPH_SCOPES, type: 'Scope' },
      { resource: 'arm', values: ['user_impersonation'], type: 'Scope' },
      { resource: 'exchange', values: ['Exchange.Manage'], type: 'Scope' },
    ],
    automation: [{ resource: 'graph', values: AUTOMATION_GRAPH_ROLES, type: 'Role' }],
  };
}

/** Env keys that lift a ceiling, and why a permission is withheld without them. */
export const CEILINGS = {
  privileged: {
    envKey: 'AF_ALLOW_PRIVILEGED_WRITE_SCOPES',
    reason:
      'tier-0 delegated permission (an armed session could change who holds privilege); set AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true to grant it',
  },
  automationWrite: {
    envKey: 'AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS',
    reason:
      'changes data; set AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true to grant write permissions to the automation identity',
  },
  automationSensitive: {
    envKey: 'AF_AUTOMATION_ALLOW_SENSITIVE_READS',
    reason:
      'reads mail, files, chats or other personal content tenant-wide; set AF_AUTOMATION_ALLOW_SENSITIVE_READS=true to grant it to the automation identity',
  },
  appPrivileged: {
    envKey: 'AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS',
    reason:
      'tier-0 application permission (an unattended identity could change who holds privilege); set AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true and AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true to grant it',
  },
  // A named app identity (ADR-014) needs its own opt-in on top of the global one; AF_IDENTITY_<NAME>_ is filled in.
  identityWrite: {
    envKey: 'AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS',
    reason:
      'changes data; set AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS=true and AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true to grant it to this app identity',
  },
  identitySensitive: {
    envKey: 'AF_IDENTITY_<NAME>_ALLOW_SENSITIVE_READS',
    reason:
      'reads mail, files, chats or other personal content tenant-wide; set AF_IDENTITY_<NAME>_ALLOW_SENSITIVE_READS=true and AF_AUTOMATION_ALLOW_SENSITIVE_READS=true to grant it to this app identity',
  },
  identityPrivileged: {
    envKey: 'AF_IDENTITY_<NAME>_ALLOW_PRIVILEGED_PERMISSIONS',
    reason:
      'tier-0 application permission; set AF_IDENTITY_<NAME>_ALLOW_PRIVILEGED_PERMISSIONS=true, AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true and both write opt-ins to grant it to this app identity',
  },
} as const;

/** Why `w` is withheld, naming the identity's own keys for a named app identity. */
export const ceilingReason = (w: Pick<Withheld, 'app' | 'ceiling'>): string =>
  isIdentityApp(w.app)
    ? CEILINGS[w.ceiling].reason.replace(/AF_IDENTITY_<NAME>_/g, identityEnvPrefix(identityNameOf(w.app)))
    : CEILINGS[w.ceiling].reason;

/** A permission the baseline or content asks for that a ceiling withholds. */
export interface Withheld {
  app: AppKey;
  resource: ResourceKey;
  value: string;
  ceiling: keyof typeof CEILINGS;
}

export type CeilingSettings = Pick<
  ProvisionSettings,
  | 'allowAutomationWrites'
  | 'allowPrivilegedWriteScopes'
  | 'allowAutomationSensitiveReads'
  | 'allowAppPrivileged'
  | 'emailDelivery'
  | 'advancedHunting'
> &
  Partial<Pick<ProvisionSettings, 'identities'>>;

/** Which ceiling (if any) withholds `value` from `app`. */
export function ceilingFor(
  settings: CeilingSettings,
  app: AppKey,
  resource: ResourceKey,
  value: string,
): keyof typeof CEILINGS | undefined {
  // Every app-only identity is held to the automation identity's ceilings; a named one (ADR-014) also to its own
  // opt-ins — one identity's permission to write never extends to another's.
  if (isAppOnly(app)) {
    const named = isIdentityApp(app);
    const own = named ? settings.identities?.find((i) => i.name === identityNameOf(app)) : undefined;
    const lifted = (global: boolean | undefined, mine: boolean | undefined) => !!global && (!named || !!mine);
    if (isPrivilegedDelegatedScope(value) && !lifted(settings.allowAppPrivileged, own?.allowPrivileged))
      return named ? 'identityPrivileged' : 'appPrivileged';
    if (
      !isReadOnlyAppRole(value) &&
      !isPerResourceAppRole(value) &&
      !lifted(settings.allowAutomationWrites, own?.allowWrites)
    )
      return named ? 'identityWrite' : 'automationWrite';
    if (
      isSensitiveReadAppRole(value) &&
      !lifted(settings.allowAutomationSensitiveReads, own?.allowSensitiveReads)
    )
      return named ? 'identitySensitive' : 'automationSensitive';
    return undefined;
  }
  if (!settings.allowPrivilegedWriteScopes && resource === 'graph' && isPrivilegedDelegatedScope(value))
    return 'privileged';
  return undefined;
}

/**
 * Pure, no tenant lookups: the permission names each app gets — baseline ∪ content-declared (∪ the read-only scopes
 * of write content for the Read app) — after the ceilings. `adminforge validate --scopes` uses the same function, so
 * provisioning and validation agree on what is expected.
 */
export function desiredPermissions(
  settings: CeilingSettings,
  content: ContentScopes = {},
): { requests: Record<AppKey, PermissionRequest[]>; withheld: Withheld[] } {
  const baseline = baselinePermissions();
  const declared = (app: AppKey, type: 'Scope' | 'Role'): PermissionRequest[] =>
    Object.entries(content[app] ?? {}).flatMap(([service, values]) => {
      const resource = SERVICE_RESOURCE[service];
      const list = [...(values ?? [])];
      return resource && list.length ? [{ resource, values: list, type }] : [];
    });
  const withheld: Withheld[] = [];
  const ceiling = (app: AppKey, requests: PermissionRequest[]) =>
    requests.flatMap((r) => {
      const values = r.values.filter((value) => {
        const c = ceilingFor(settings, app, r.resource, value);
        if (c) withheld.push({ app, resource: r.resource, value, ceiling: c });
        return !c;
      });
      return values.length ? [{ ...r, values }] : [];
    });
  // Each named app identity: exactly what the schedules naming it declare (no baseline), under the same ceilings.
  const named = Object.fromEntries(
    (settings.identities ?? []).map(({ name }) => {
      const key = identityAppKey(name);
      return [key, ceiling(key, mergeByResource(declared(key, 'Role')))];
    }),
  ) as unknown as Record<AppKey, PermissionRequest[]>;
  return {
    requests: {
      ...named,
      read: ceiling(
        'read',
        mergeByResource([
          ...baseline.read,
          ...declared('read', 'Scope'),
          { resource: 'graph', values: readOnly(content.write?.graph), type: 'Scope' },
          // Built-in Query Studio advanced hunting (query/service.ts), only where AF_QUERY_SOURCES offers it.
          ...(settings.advancedHunting
            ? [{ resource: 'graph' as const, values: ['ThreatHunting.Read.All'], type: 'Scope' as const }]
            : []),
        ]),
      ),
      write: ceiling('write', mergeByResource([...baseline.write, ...declared('write', 'Scope')])),
      automation: ceiling(
        'automation',
        mergeByResource([
          ...baseline.automation,
          ...declared('automation', 'Role'),
          // Built-in email delivery (delivery/notifier.ts) sends as AF_MAIL_SENDER.
          ...(settings.emailDelivery
            ? [{ resource: 'graph' as const, values: ['Mail.Send'], type: 'Role' as const }]
            : []),
        ]),
      ),
    },
    withheld,
  };
}

/**
 * Desired Entra objects. Each app's permissions = the baseline catalog ∪ what published content declares
 * (`requires.scopes`), under the ceilings in provision/privilege.ts, so provisioning and `adminforge validate --scopes`
 * stay in sync (least privilege, verified).
 */
export function buildDesiredEntra(
  settings: ProvisionSettings,
  resources: Resources,
  content: ContentScopes = {},
): DesiredEntra {
  const { label, baseUrl } = settings;
  const skipped: Skipped[] = [];
  const apps: DesiredApp[] = [];
  const { requests, withheld } = desiredPermissions(settings, content);
  for (const w of withheld)
    skipped.push(
      isAppOnly(w.app)
        ? {
            section: 'App role assignments',
            title: `${isIdentityApp(w.app) ? identityNameOf(w.app) : 'automation'} → ${RESOURCES[w.resource].name}: ${w.value}`,
            reason: ceilingReason(w),
          }
        : {
            section: 'Consent grants',
            title: `${appNames(label, w.app).displayName} → ${RESOURCES[w.resource].name}: ${w.value}`,
            reason: ceilingReason(w),
          },
    );

  const delegatedApp = (
    key: 'read' | 'write',
    redirectPath: string | string[],
    extra: Partial<ApplicationBody>,
  ) => {
    const names = appNames(label, key);
    const { rra, resolved } = resolvePermissions(names.displayName, requests[key], resources, skipped);
    apps.push({
      key,
      uniqueName: names.uniqueName,
      body: appBody(
        names.displayName,
        [baseUrl, ...(settings.extraBaseUrls ?? [])].flatMap((base) =>
          [redirectPath].flat().map((path) => `${base}${path}`),
        ),
        rra,
        extra,
      ),
      sp: { appRoleAssignmentRequired: true, tags: [ENTERPRISE_APP_TAG] },
      grants: resolved.map((r) => ({ resource: r.resource, scopes: r.items.map((i) => i.value) })),
      appPermissions: [],
      env: ENV_KEYS[key],
    });
    return resolved;
  };

  const readResolved = delegatedApp(
    'read',
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
      // acct tells member (0) from guest (1) accounts, so the API can refuse guests from the ID token itself;
      // auth_time proves the sign-in that lets a schedule use someone's access was a fresh one.
      optionalClaims: {
        idToken: idTokenClaims('auth_time', 'acrs', 'login_hint', 'acct'),
        accessToken: [],
        saml2Token: [],
      },
    },
  );

  delegatedApp('write', '/auth/arm/callback', {
    // auth_time proves the step-up was a fresh sign-in; acrs carries a satisfied Conditional Access auth context;
    // acct (0 member, 1 guest) lets the API refuse guest accounts.
    optionalClaims: {
      idToken: idTokenClaims('auth_time', 'acrs', 'acct'),
      accessToken: [],
      saml2Token: [],
    },
  });

  {
    const names = appNames(label, 'automation');
    const { rra, resolved } = resolvePermissions(names.displayName, requests.automation, resources, skipped);
    apps.push({
      key: 'automation',
      uniqueName: names.uniqueName,
      body: appBody(names.displayName, [], rra),
      // Nobody signs in to the automation app and nothing calls it as a resource: require assignment anyway.
      sp: { appRoleAssignmentRequired: true, tags: [ENTERPRISE_APP_TAG] },
      grants: [],
      appPermissions: resolved.map((r) => ({ resource: r.resource, roles: r.items })),
      env: envKeysFor('automation'),
      ...(settings.automationCertificate ? { certificate: settings.automationCertificate } : {}),
    });
  }

  // Named app identities (ADR-014): app registrations like the automation one, each with its own permissions.
  for (const identity of settings.identities ?? []) {
    const key = identityAppKey(identity.name);
    const names = appNames(label, key);
    const { rra, resolved } = resolvePermissions(names.displayName, requests[key] ?? [], resources, skipped);
    apps.push({
      key,
      uniqueName: names.uniqueName,
      body: appBody(names.displayName, [], rra),
      sp: { appRoleAssignmentRequired: true, tags: [ENTERPRISE_APP_TAG] },
      grants: [],
      appPermissions: resolved.map((r) => ({ resource: r.resource, roles: r.items })),
      env: envKeysFor(key),
      ...(identity.certificate ? { certificate: identity.certificate } : {}),
    });
  }

  // Write-capable delegated scopes on the Read app (provisioning warns; ARM user_impersonation is inherent).
  const readWriteCapable: DesiredEntra['readWriteCapable'] = [];
  let readArmInherent = false;
  for (const r of requests.read)
    for (const scope of r.values) {
      if (r.resource === 'arm' && scope === 'user_impersonation') readArmInherent = true;
      else if (isWriteCapableDelegatedScope(scope))
        readWriteCapable.push({
          resource: r.resource,
          scope,
          granted: readResolved.some(
            (x) => x.resource === r.resource && x.items.some((i) => i.value === scope),
          ),
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
    ...PORTAL_ROLES.map((r) => ({
      group: r.value,
      app: 'read' as const,
      appRoleId: appRoleId(label, r.value),
      roleName: r.value,
    })),
    {
      group: 'Portal.Operator' as const,
      app: 'write' as const,
      appRoleId: DEFAULT_ACCESS_ROLE_ID,
      roleName: 'Default access',
    },
  ];

  let arm: DesiredEntra['arm'];
  if (settings.subscriptionId) {
    const scope = `/subscriptions/${settings.subscriptionId}`;
    arm = {
      scope,
      roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${AZURE_READER_ROLE_ID}`,
      roleName: 'Reader',
    };
  } else {
    skipped.push({
      section: 'Azure RBAC',
      title: `${appNames(label, 'automation').displayName} → Reader on subscription`,
      reason: 'AF_SUBSCRIPTION_ID is not set',
    });
  }

  return { settings, apps, groups, groupAssignments, arm, skipped, readWriteCapable, readArmInherent };
}
