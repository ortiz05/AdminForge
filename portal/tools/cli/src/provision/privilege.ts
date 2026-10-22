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
 * Tier-0 application permissions: the delegated list plus what an unattended identity could use to change tenant
 * trust or who holds privilege without a signed-in user. Any app-only identity gets them only with
 * AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true (on top of the write opt-in). The delegated list above is unchanged:
 * these names stay ordinary write scopes for the Write app. Microsoft keeps adding narrower names for the same power
 * (one authentication method, one domain's federation), so families are matched by pattern as well as by name; the test
 * lists names each family must catch (tests/unit/cli/app-only-ceilings.test.ts).
 */
export const PRIVILEGED_APP_ROLES = [
  ...PRIVILEGED_DELEGATED_SCOPES,
  // Sign-in trust: certificate-based authentication and federation (organization settings, PKI, mutual TLS, domain
  // federation, B2C and SPIFFE trust), and tenant-wide restricted objects and passwords.
  'Organization.ReadWrite.All',
  'PublicKeyInfrastructure.ReadWrite.All',
  'MutualTlsOauthConfiguration.ReadWrite.All',
  'Domain-InternalFederation.ReadWrite.All',
  'TrustFrameworkKeySet.ReadWrite.All',
  'SpiffeTrustDomain.ReadWrite.All',
  'Directory.Write.Restricted',
  'User-PasswordProfile.ReadWrite.All',
  // Authentication contexts: AdminForge's step-up (arming) asks Conditional Access for one.
  'AuthenticationContext.ReadWrite.All',
  'OnPremDirectorySynchronization.ReadWrite.All',
  'Synchronization.ReadWrite.All',
  // Credentials of apps and agent blueprints (Application.ReadUpdate.All updates any app, its credentials included).
  'Application.ReadWrite.OwnedBy',
  'Application.ReadUpdate.All',
  // Who holds privilege: group membership (AdminForge's own SG-AdminForge-* role groups are ordinary groups) and
  // partner (GDAP) admin relationships.
  'Group.ReadWrite.All',
  'GroupMember.ReadWrite.All',
  'DelegatedAdminRelationship.ReadWrite.All',
  // Intune: scripts, apps and configuration run as SYSTEM on every managed device (administrators' devices
  // included); Intune roles; wiping every device.
  'DeviceManagementConfiguration.ReadWrite.All',
  'DeviceManagementScripts.ReadWrite.All',
  'DeviceManagementApps.ReadWrite.All',
  'DeviceManagementRBAC.ReadWrite.All',
  'DeviceManagementManagedDevices.PrivilegedOperations.All',
] as const;

const PRIVILEGED_APP = new Set(PRIVILEGED_APP_ROLES.map((s) => s.toLowerCase()));

/**
 * Tier-0 families, whatever Microsoft adds to them: role management and PIM, tenant policies, every user's
 * authentication methods (one method at a time too: a Temporary Access Pass for an administrator), lifecycle
 * workflows (their built-in tasks add group members and issue passes), agent blueprint credentials, and Teams app
 * installations that consent to permissions. The application-permission reports keep a copy
 * (`identity.app-permissions`, `identity.app-registration-risks`: `$criticalFamily`), and
 * tests/content/app-permissions-critical-tier.test.ts fails when they drift.
 */
export const PRIVILEGED_APP_FAMILIES: readonly RegExp[] = [
  /^(RoleManagement|RoleManagementPolicy|RoleAssignmentSchedule|RoleEligibilitySchedule|PrivilegedAccess|PrivilegedAssignmentSchedule|PrivilegedEligibilitySchedule|Policy)\.ReadWrite\./i,
  /^UserAuth(entication)?Method(-[A-Za-z]+)?\.(ReadWrite|Delete)\./i,
  /^LifecycleWorkflows(-Workflow)?\.(ReadWrite\.All|Activate)$/i,
  /^AgentIdentityBlueprint\.(AddRemoveCreds|ReadWrite|UpdateAuthProperties)\./i,
  /^TeamsAppInstallation\.ReadWriteAndConsent/i,
];

/** Whether an application permission is tier 0 for an app-only identity (PRIVILEGED_APP_ROLES and their families). */
export const isPrivilegedAppRole = (value: string) =>
  PRIVILEGED_APP.has(value.toLowerCase()) || PRIVILEGED_APP_FAMILIES.some((p) => p.test(value));

/**
 * Application permissions that read personal or secret content tenant-wide, whatever their verb: mail (inbox rules
 * that forward it included), mailbox items and exports, calendars, contacts, OneNote and sticky notes, OneDrive and
 * SharePoint files and sites (Read, ReadWrite, Manage and FullControl alike — full control of every site reads every
 * file; Graph and the SharePoint resource publish the same names), Teams chats and channel messages and the
 * memberships that open them, group and Viva Engage conversations, meetings' and calls' transcripts, recordings, AI
 * notes, records and media, Copilot interactions, print jobs, BitLocker keys and Windows LAPS passwords, users'
 * authentication methods, tasks, people, presence, eDiscovery data and EWS access to every mailbox. An app-only
 * identity gets them only with AF_AUTOMATION_ALLOW_SENSITIVE_READS=true, on top of the write opt-in for the ones that
 * also change data. Not covered: Sites.Selected (granted per site), the ReadBasic siblings (metadata only),
 * Exchange.ManageAsApp (it reaches nothing until an Exchange role is assigned to the app, which provisioning never
 * does) and, pending a decision, ThreatHunting.Read.All and ExchangeMessageTrace.Read.All (docs/backlog.md).
 */
export const SENSITIVE_READ_PATTERNS: readonly RegExp[] = [
  /^Mail(-Advanced)?\.Read/i,
  /^MailboxFolder\.Read/i,
  /^MailboxItem\.(Read|Export|ImportExport)/i,
  // Inbox rules that forward or redirect every mailbox's mail.
  /^MailboxSettings\.ReadWrite/i,
  /^Calendars\.Read/i,
  /^Contacts\.Read/i,
  /^Notes\.Read/i,
  /^ShortNotes\.Read/i,
  /^Files\.Read/i,
  /^Sites\.(Read|Manage|FullControl)/i,
  /^(Chat|ChatMessage|ChannelMessage)\.Read/i,
  // Adding a member to any team, private channel or chat opens its history.
  /^(TeamMember|ChannelMember|ChatMember)\.ReadWrite/i,
  /^Group-Conversation\./i,
  /^Engagement(Conversation|MeetingConversation|Export)\./i,
  /^OnlineMeeting(Transcript|Recording|Artifact|AiInsight)\.Read/i,
  /^Call(Records|Record-PstnCalls|Recordings|Transcripts|AiInsights)\.Read/i,
  // Joining any meeting or group call, and its media.
  /^Calls\.(AccessMedia|JoinGroupCall)/i,
  /^RealTimeActivityFeed\.Read/i,
  // Every user's Copilot prompts and responses.
  /^AiEnterpriseInteraction\.Read/i,
  /^PrintJob\.(Read|ReadWrite|Manage)\.All$/i,
  /^BitlockerKey\.Read\.All$/i,
  /^DeviceLocalCredential\.Read\.All$/i,
  /^UserAuth(entication)?Method(-[A-Za-z]+)?\.Read/i,
  /^People\.Read/i,
  // Everyone's real-time presence (in a call, presenting, away): personal, and it can't be narrowed to a test user.
  /^Presence\.Read/i,
  /^Tasks\.Read/i,
  /^eDiscovery\.Read/i,
  // Export of any user's data (customer content and logs).
  /^User\.Export\./i,
  /^full_access_as_app$/i,
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
