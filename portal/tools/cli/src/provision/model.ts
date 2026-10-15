import type { PortalRole, ResourceKey } from './catalog';

/** The three AdminForge app registrations. */
export type AppKey = 'read' | 'write' | 'automation';
export const APP_KEYS: readonly AppKey[] = ['read', 'write', 'automation'];

/** What provisioning will do with one object. `skip` = cannot be done here (licensing/permissions/config). */
export type Action = 'create' | 'update' | 'noop' | 'skip';

export interface ProvisionSettings {
  /** Environment label used in names (AF_ENV_LABEL, default "dev"). */
  label: string;
  /** PUBLIC_BASE_URL without a trailing slash; base for redirect URIs. */
  baseUrl: string;
  tenantId: string;
  subscriptionId?: string;
  primaryDomain?: string;
}

// ── Microsoft Graph shapes (the subset AdminForge reads and writes) ───────────

export interface AppRole {
  id: string;
  value: string;
  displayName: string;
  description: string;
  allowedMemberTypes: string[];
  isEnabled: boolean;
}

export interface ResourceAccess {
  id: string;
  type: 'Scope' | 'Role';
}

export interface RequiredResourceAccess {
  resourceAppId: string;
  resourceAccess: ResourceAccess[];
}

export interface OptionalClaim {
  name: string;
  source?: string | null;
  essential?: boolean;
  additionalProperties?: string[];
}

export interface ApplicationBody {
  displayName: string;
  signInAudience: 'AzureADMyOrg';
  groupMembershipClaims: string | null;
  web: {
    redirectUris: string[];
    implicitGrantSettings: { enableAccessTokenIssuance: boolean; enableIdTokenIssuance: boolean };
  };
  appRoles: AppRole[];
  optionalClaims: { idToken: OptionalClaim[]; accessToken: OptionalClaim[]; saml2Token: OptionalClaim[] };
  requiredResourceAccess: RequiredResourceAccess[];
}

export interface PasswordCredential {
  keyId: string;
  displayName?: string | null;
  hint?: string | null;
  endDateTime?: string | null;
}

export interface GraphApplication {
  id: string;
  appId: string;
  displayName?: string;
  uniqueName?: string | null;
  signInAudience?: string;
  groupMembershipClaims?: string | null;
  web?: Partial<ApplicationBody['web']> | null;
  appRoles?: AppRole[];
  optionalClaims?: Partial<ApplicationBody['optionalClaims']> | null;
  requiredResourceAccess?: RequiredResourceAccess[];
  passwordCredentials?: PasswordCredential[];
}

export interface ServicePrincipalBody {
  appRoleAssignmentRequired: boolean;
  tags: string[];
}

export interface GraphServicePrincipal {
  id: string;
  appId: string;
  displayName?: string;
  appRoleAssignmentRequired?: boolean;
  tags?: string[];
}

export interface PermissionScope {
  id: string;
  value: string;
  isEnabled?: boolean;
}

export interface ResourceServicePrincipal extends GraphServicePrincipal {
  oauth2PermissionScopes: PermissionScope[];
  appRoles: Array<{ id: string; value: string | null; allowedMemberTypes?: string[]; isEnabled?: boolean }>;
}

export interface PermissionGrant {
  id: string;
  clientId: string;
  resourceId: string;
  consentType: string;
  principalId?: string | null;
  scope: string;
}

export interface AppRoleAssignment {
  id: string;
  principalId: string;
  resourceId: string;
  appRoleId: string;
  principalDisplayName?: string;
  resourceDisplayName?: string;
}

export interface GroupBody {
  displayName: string;
  description: string;
  mailEnabled: false;
  mailNickname: string;
  securityEnabled: true;
  groupTypes: string[];
}

export interface GraphGroup {
  id: string;
  displayName: string;
  uniqueName?: string | null;
  description?: string | null;
  securityEnabled?: boolean;
  mailEnabled?: boolean;
}

export interface ArmRoleAssignment {
  id: string;
  name: string;
  properties: { roleDefinitionId: string; principalId: string; scope: string };
}

// ── Desired state ─────────────────────────────────────────────────────────────

export interface Skipped {
  section: Section;
  title: string;
  reason: string;
}

export interface DesiredApp {
  key: AppKey;
  uniqueName: string;
  body: ApplicationBody;
  sp: ServicePrincipalBody;
  /** Delegated permissions with tenant-wide admin consent (oauth2PermissionGrants, AllPrincipals). */
  grants: Array<{ resource: ResourceKey; scopes: string[] }>;
  /** Application permissions (app role assignments on resource service principals). */
  appPermissions: Array<{ resource: ResourceKey; roles: Array<{ value: string; id: string }> }>;
  env: { clientId: string; secret: string };
}

export interface DesiredGroup {
  role: PortalRole;
  uniqueName: string;
  body: GroupBody;
}

export interface DesiredGroupAssignment {
  group: PortalRole;
  app: AppKey;
  appRoleId: string;
  /** Role name for display ("Portal.Reader", "Default access"). */
  roleName: string;
}

export interface DesiredEntra {
  settings: ProvisionSettings;
  apps: DesiredApp[];
  groups: DesiredGroup[];
  groupAssignments: DesiredGroupAssignment[];
  /** Built-in Reader on the subscription for the automation identity; undefined when AF_SUBSCRIPTION_ID is empty. */
  arm?: { scope: string; roleDefinitionId: string; roleName: string };
  /** Things that cannot be provisioned in this tenant (missing resource SPs, unknown scopes, missing config). */
  skipped: Skipped[];
}

// ── Current state (fetched) ───────────────────────────────────────────────────

export interface EntraState {
  resources: Partial<Record<ResourceKey, ResourceServicePrincipal>>;
  apps: Partial<Record<AppKey, GraphApplication>>;
  sps: Partial<Record<AppKey, GraphServicePrincipal>>;
  /** oauth2PermissionGrants whose client is the app's service principal. */
  grants: Partial<Record<AppKey, PermissionGrant[]>>;
  /** appRoleAssignedTo: who is assigned to the app's service principal. */
  assignedTo: Partial<Record<AppKey, AppRoleAssignment[]>>;
  /** appRoleAssignments: application permissions the app's service principal holds. */
  appPermissions: Partial<Record<AppKey, AppRoleAssignment[]>>;
  groups: Partial<Record<PortalRole, GraphGroup>>;
  /** Azure role assignments of the automation principal at the subscription (or why they could not be read). */
  arm: { assignments: ArmRoleAssignment[]; error?: string };
  /** Env-file values (only keys AdminForge reads; never printed). */
  env: Record<string, string | undefined>;
}

// ── Operations (the plan) ─────────────────────────────────────────────────────

export type Section =
  | 'Applications'
  | 'Service principals'
  | 'Local credentials'
  | 'Groups'
  | 'Consent grants'
  | 'App role assignments'
  | 'Azure RBAC'
  | 'Test identities'
  | 'Group membership'
  | 'Directory roles'
  | 'Write-test targets';

interface OpBase {
  action: Action;
  section: Section;
  title: string;
  /** What differs (update) or why (skip/create); never contains secret values. */
  changes?: string[];
  /** Extra non-secret detail for status output (e.g. a grant's scope string). */
  detail?: string;
}

export type PrincipalRef = { group: PortalRole } | { app: AppKey };
export type ResourceRef = { app: AppKey } | { resource: ResourceKey };

export type EntraOp =
  | (OpBase & { kind: 'application'; app: AppKey; uniqueName: string; body: ApplicationBody })
  | (OpBase & { kind: 'servicePrincipal'; app: AppKey; body: ServicePrincipalBody })
  | (OpBase & { kind: 'envClientId'; app: AppKey; envKey: string })
  | (OpBase & { kind: 'secret'; app: AppKey; envKey: string; displayName: string; days: number })
  | (OpBase & { kind: 'group'; role: PortalRole; uniqueName: string; body: GroupBody })
  | (OpBase & { kind: 'grant'; app: AppKey; resource: ResourceKey; scope: string; grantId?: string })
  | (OpBase & { kind: 'appRoleAssignment'; principal: PrincipalRef; target: ResourceRef; appRoleId: string })
  | (OpBase & { kind: 'armRoleAssignment'; scope: string; roleDefinitionId: string })
  | (OpBase & { kind: 'skipped' });

export type PlanOp = Pick<OpBase, 'action' | 'section' | 'title' | 'changes' | 'detail'>;
