/**
 * The provisioning data model: AdminForge's settings for one environment (`ProvisionSettings`), the subset of
 * Microsoft Graph / ARM shapes provisioning reads and writes, the desired state (`DesiredEntra`), the fetched state
 * (`EntraState`) and the operations a plan produces (`EntraOp`). Types only (plus `APP_KEYS`): no I/O, no logic.
 *
 * Used by every `provision/*` module: `*-desired.ts` builds the desired state, `*-io.ts` fetches state and applies
 * operations, `*-plan.ts` compares the two. Nothing here is tenant-specific (R2).
 */
import type { PlanAction } from '../shared/output';
import type { PortalRole, ResourceKey } from './catalog';

/** A named app identity schedules may run as (ADR-014, AF_SCHEDULE_IDENTITIES): `identity:<name>`. */
export type IdentityAppKey = `identity:${string}`;
/** AdminForge's app registrations: the Read, Write and Automation apps, and each named app identity. */
export type AppKey = 'read' | 'write' | 'automation' | IdentityAppKey;
/** The three built-in app registrations (every installation has them). */
export const APP_KEYS: readonly AppKey[] = ['read', 'write', 'automation'];

export const identityAppKey = (name: string): IdentityAppKey => `identity:${name}`;
export const isIdentityApp = (key: string): key is IdentityAppKey => key.startsWith('identity:');
/** The app identity's name (`identity:reports-team` → `reports-team`). */
export const identityNameOf = (key: IdentityAppKey) => key.slice('identity:'.length);
/** App-only identities: the automation identity and the named app identities (application permissions). */
export const isAppOnly = (key: string) => key === 'automation' || isIdentityApp(key);

/**
 * What provisioning will do with one object. `skip` = cannot be done here (licensing/permissions/config);
 * `delete` = remove something AdminForge manages that is no longer wanted (a credential, a test-user role).
 * Defined with the renderers in shared/output.ts.
 */
export type Action = PlanAction;

export interface ProvisionSettings {
  /** Environment label used in names (AF_ENV_LABEL, default "dev"). */
  label: string;
  /** PUBLIC_BASE_URL without a trailing slash; base for redirect URIs. */
  baseUrl: string;
  /** Further origins that serve this environment (AF_REDIRECT_BASE_URLS), e.g. the host deployment next to the dev server. */
  extraBaseUrls?: string[];
  tenantId: string;
  subscriptionId?: string;
  primaryDomain?: string;
  /**
   * Grant application permissions that change data when content declares them for the automation identity
   * (AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true). Off by default: a merged schedule could otherwise give the
   * unattended identity tenant-wide write access on the next provisioning run.
   */
  allowAutomationWrites?: boolean;
  /**
   * Grant tier-0 delegated permissions (provision/privilege.ts) to the Read/Write apps when content declares them
   * (AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true). Off by default: skipped and listed in the plan.
   */
  allowPrivilegedWriteScopes?: boolean;
  /**
   * Grant application permissions that read mail, files, chats and other personal content to the automation identity
   * when content declares them (AF_AUTOMATION_ALLOW_SENSITIVE_READS=true). Off by default.
   */
  allowAutomationSensitiveReads?: boolean;
  /**
   * Grant tier-0 application permissions (provision/privilege.ts: role management, app credentials and consent,
   * tenant policies, …) to an app-only identity — the automation identity or a named one — when content declares them
   * (AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true, on top of AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS). Off by default:
   * an unattended identity holding them could change who holds privilege in the tenant.
   */
  allowAppPrivileged?: boolean;
  /**
   * AF_MAIL_SENDER is set: reports and alerts are emailed as the automation identity, which needs the Mail.Send
   * application permission — a write permission, so still only with AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true.
   */
  emailDelivery?: boolean;
  /**
   * Query Studio offers Defender advanced hunting (AF_QUERY_SOURCES unset, or listing `advancedHunting`): it runs as the
   * signed-in user through the Read app, which then needs the delegated ThreatHunting.Read.All.
   */
  advancedHunting?: boolean;
  /** AF_AUTOMATION_CERT_PATH: the automation identity authenticates with this certificate instead of a secret. */
  automationCertificate?: CertificateInfo;
  /**
   * The named app identities schedules may run as (AF_SCHEDULE_IDENTITIES, ADR-014), each an app registration of its
   * own with application permissions, a certificate from AF_IDENTITY_<NAME>_CERT_PATH when set (else a secret).
   */
  identities?: Array<{
    name: string;
    certificate?: CertificateInfo;
    /**
     * Per-identity opt-ins, each on top of the matching global one (both must be "true"):
     * AF_IDENTITY_<NAME>_ALLOW_WRITE_PERMISSIONS, _ALLOW_SENSITIVE_READS, _ALLOW_PRIVILEGED_PERMISSIONS.
     */
    allowWrites?: boolean;
    allowSensitiveReads?: boolean;
    allowPrivileged?: boolean;
  }>;
  /** Whether AF_ENV_LABEL is a test environment (AF_TEST_IDENTITY_LABELS, default dev,test): test identities allowed. */
  testIdentitiesAllowed?: boolean;
}

/** Public part of the automation certificate (the private key never leaves the PEM file). */
export interface CertificateInfo {
  /** Base64 DER of the X.509 certificate (Graph keyCredential.key). */
  key: string;
  /** SHA-1 thumbprint, upper-case hex (what Graph returns as customKeyIdentifier). */
  thumbprint: string;
  startDateTime: string;
  endDateTime: string;
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
  /** Never a public client: no device-code/ROPC flows without a client secret. */
  isFallbackPublicClient: boolean;
  publicClient: { redirectUris: string[] };
  spa: { redirectUris: string[] };
  appRoles: AppRole[];
  optionalClaims: { idToken: OptionalClaim[]; accessToken: OptionalClaim[]; saml2Token: OptionalClaim[] };
  requiredResourceAccess: RequiredResourceAccess[];
}

export interface KeyCredential {
  keyId?: string;
  type?: string;
  usage?: string;
  displayName?: string | null;
  /** Base64 of the SHA-1 thumbprint bytes. */
  customKeyIdentifier?: string | null;
  endDateTime?: string | null;
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
  keyCredentials?: KeyCredential[];
  isFallbackPublicClient?: boolean | null;
  publicClient?: { redirectUris?: string[] } | null;
  spa?: { redirectUris?: string[] } | null;
  identifierUris?: string[];
  api?: { oauth2PermissionScopes?: Array<{ id: string; value?: string | null }> } | null;
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
  passwordCredentials?: PasswordCredential[];
  keyCredentials?: KeyCredential[];
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
  /** User, Group or ServicePrincipal. */
  principalType?: string;
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
  env: {
    clientId: string;
    secret: string;
    /** The certificate path key (app-only identities). */ cert?: string;
  };
  /**
   * Certificate credential that replaces the client secret (an app-only identity with its …_CERT_PATH: the automation
   * identity's AF_AUTOMATION_CERT_PATH, a named identity's AF_IDENTITY_<NAME>_CERT_PATH).
   */
  certificate?: CertificateInfo;
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
  /** Write-capable delegated scopes requested for the Read app (granted = the resource exists in this tenant). */
  readWriteCapable: Array<{ resource: ResourceKey; scope: string; granted: boolean }>;
  /** ARM user_impersonation is requested for the Read app (inherent: ARM has no read-only delegated scope). */
  readArmInherent: boolean;
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
  /** Owners (object ids) of each app registration and its service principal. */
  owners?: Partial<Record<AppKey, { app: string[]; sp: string[] }>>;
  /** Object id of the provisioner's own service principal (to tell its ownership apart). */
  provisionerSpId?: string;
  /**
   * App registrations of named app identities of this environment that AF_SCHEDULE_IDENTITIES no longer lists
   * (ADR-014): they keep their application permissions until deleted. AdminForge's write guard still protects them.
   */
  retiredIdentities?: Array<{ displayName: string; appId: string }>;
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
  | 'Write-test targets'
  | 'Azure test environment'
  | 'Activity log export'
  | 'Env file'
  | 'Unexpected privilege';

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
  | (OpBase & { kind: 'keyCredential'; app: AppKey; certificate: CertificateInfo; displayName: string })
  | (OpBase & { kind: 'removePassword'; app: AppKey; keyId: string })
  | (OpBase & { kind: 'group'; role: PortalRole; uniqueName: string; body: GroupBody })
  | (OpBase & { kind: 'grant'; app: AppKey; resource: ResourceKey; scope: string; grantId?: string })
  | (OpBase & { kind: 'appRoleAssignment'; principal: PrincipalRef; target: ResourceRef; appRoleId: string })
  /** `provision entra --prune`: an application permission on one of AdminForge's apps that provisioning doesn't grant. */
  | (OpBase & { kind: 'appRoleRemove'; app: AppKey; assignmentId: string })
  | (OpBase & { kind: 'armRoleAssignment'; scope: string; roleDefinitionId: string })
  | (OpBase & { kind: 'skipped' });

export type PlanOp = Pick<OpBase, 'action' | 'section' | 'title' | 'changes' | 'detail'>;
