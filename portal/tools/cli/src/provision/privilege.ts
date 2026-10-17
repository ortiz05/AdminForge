/**
 * Permission ceilings that `adminforge provision entra` applies on top of the catalog and content (`requires.scopes`).
 * Content can declare anything; these lists decide what provisioning grants without an explicit opt-in in the env file
 * (SECURITY.md → Identities). Names are Microsoft-published permission values, never tenant data.
 */

/** OIDC sign-in scopes every delegated app holds. */
export const SIGN_IN_SCOPES: ReadonlySet<string> = new Set([
  'openid',
  'profile',
  'offline_access',
  'email',
  'user.read',
]);

/**
 * Tier-0 delegated Microsoft Graph permissions. With one of them an armed session (or a compromised API) can change
 * who holds privilege: assign or schedule directory roles, add credentials or app-role grants to any app, consent to
 * permissions, rewrite tenant-wide policies or federation, or act with the signed-in user's full directory rights
 * (Directory.AccessAsUser.All is a superset of Directory.ReadWrite.All). Granted to the Read and Write apps only with
 * AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true.
 */
export const PRIVILEGED_DELEGATED_SCOPES = [
  'Directory.AccessAsUser.All',
  'Directory.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
  'RoleAssignmentSchedule.ReadWrite.Directory',
  'RoleEligibilitySchedule.ReadWrite.Directory',
  'RoleManagementPolicy.ReadWrite.Directory',
  'PrivilegedAccess.ReadWrite.AzureADGroup',
  'PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup',
  'PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup',
  'AppRoleAssignment.ReadWrite.All',
  'DelegatedPermissionGrant.ReadWrite.All',
  'Application.ReadWrite.All',
  'Policy.ReadWrite.ConditionalAccess',
  'Policy.ReadWrite.AuthenticationMethod',
  'Policy.ReadWrite.PermissionGrant',
  'Policy.ReadWrite.Authorization',
  'Policy.ReadWrite.CrossTenantAccess',
  'Domain.ReadWrite.All',
  'IdentityProvider.ReadWrite.All',
  'EntitlementManagement.ReadWrite.All',
] as const;

const PRIVILEGED = new Set(PRIVILEGED_DELEGATED_SCOPES.map((s) => s.toLowerCase()));

/** Whether a delegated Microsoft Graph scope is tier 0 (see PRIVILEGED_DELEGATED_SCOPES; any RoleManagement.ReadWrite.*). */
export const isPrivilegedDelegatedScope = (scope: string) =>
  PRIVILEGED.has(scope.toLowerCase()) || /^RoleManagement\.ReadWrite\./i.test(scope);

/**
 * Application permissions that read personal or secret content tenant-wide: mail, mailbox items, calendars, contacts,
 * OneNote, OneDrive/SharePoint files, Teams chats and channel messages, meeting transcripts and recordings, BitLocker
 * recovery keys, users' authentication methods, tasks, people and eDiscovery data. The automation identity gets them
 * only with AF_AUTOMATION_ALLOW_SENSITIVE_READS=true (Sites.Selected, which is granted per site, is not covered).
 */
export const SENSITIVE_READ_PATTERNS: readonly RegExp[] = [
  /^Mail\.Read/i,
  /^Mailbox(Item|Folder)\.Read/i,
  /^Calendars\.Read/i,
  /^Contacts\.Read/i,
  /^Notes\.Read/i,
  /^Files\.Read/i,
  /^Sites\.Read/i,
  /^(Chat|ChatMessage|ChannelMessage)\.Read/i,
  /^OnlineMeeting(Transcript|Recording|Artifact)\.Read/i,
  /^BitlockerKey\.Read\.All$/i,
  /^UserAuthenticationMethod\.Read/i,
  /^People\.Read/i,
  // Everyone's real-time presence (in a call, presenting, away): personal, and it can't be narrowed to a test user.
  /^Presence\.Read/i,
  /^Tasks\.Read/i,
  /^eDiscovery\.Read/i,
];

export const isSensitiveReadAppRole = (value: string) => SENSITIVE_READ_PATTERNS.some((p) => p.test(value));

/** Read-only permission names: `X.Read.Y`, `X.ReadBasic.Y`, `User.Read`, `Data.Read` — never `X.ReadWrite.Y`. */
export const isReadOnlyPermission = (value: string) =>
  /\.Read(Basic)?(\.|$)/.test(value) && !/ReadWrite/i.test(value);

/**
 * Delegated scopes that can change data: everything except sign-in scopes and read-only names. Exchange.Manage,
 * SharePoint AllSites.FullControl and Teams user_impersonation count; ARM user_impersonation is inherent to every
 * Azure call (Azure Resource Manager publishes no read-only delegated scope) and is reported separately.
 */
export const isWriteCapableDelegatedScope = (scope: string) =>
  !SIGN_IN_SCOPES.has(scope.toLowerCase()) && !isReadOnlyPermission(scope);
