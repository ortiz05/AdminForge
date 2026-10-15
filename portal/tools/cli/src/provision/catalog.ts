/**
 * Well-known (Microsoft-published, tenant-independent) identifiers and AdminForge's desired permissions.
 * Nothing in here is tenant-specific (R2): tenant values come from the env file at run time.
 */

/** Resource applications the portal apps request permissions on. Keys are stable logical names. */
export const RESOURCES = {
  graph: { appId: '00000003-0000-0000-c000-000000000000', name: 'Microsoft Graph' },
  arm: { appId: '797f4846-ba00-4fd7-ba43-dac1f8f63013', name: 'Azure Service Management' },
  logAnalytics: { appId: 'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5', name: 'Log Analytics API' },
  exchange: { appId: '00000002-0000-0ff1-ce00-000000000000', name: 'Office 365 Exchange Online' },
  teams: { appId: '48ac35b8-9aa8-4d74-927d-1f4a14a0b239', name: 'Skype and Teams Tenant Admin API' },
  sharepoint: { appId: '00000003-0000-0ff1-ce00-000000000000', name: 'Office 365 SharePoint Online' },
} as const;
export type ResourceKey = keyof typeof RESOURCES;
export const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];

/** Resources that only exist in licensed tenants; a missing service principal is skipped with a warning. */
export const OPTIONAL_RESOURCES: ReadonlySet<ResourceKey> = new Set(['exchange', 'teams', 'sharepoint']);

export const OIDC_SCOPES = ['openid', 'profile', 'offline_access', 'User.Read'] as const;

/** Read app, Microsoft Graph delegated scopes (Task 1.16 list + Revision 2 additions). */
export const READ_GRAPH_SCOPES = [
  ...OIDC_SCOPES,
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
] as const;

/** Write app, Microsoft Graph delegated scopes. Directory.ReadWrite.All is deliberately absent. */
export const WRITE_GRAPH_SCOPES = [
  ...OIDC_SCOPES,
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
] as const;

/** Automation identity (ADR-011), Microsoft Graph application permissions for read-mostly schedules. */
export const AUTOMATION_GRAPH_ROLES = [
  'Directory.Read.All',
  'User.Read.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'Application.Read.All',
  'AuditLog.Read.All',
  'Reports.Read.All',
  'ServiceHealth.Read.All',
  'ServiceMessage.Read.All',
  'Policy.Read.All',
  'RoleManagement.Read.Directory',
  'Organization.Read.All',
  'Device.Read.All',
  'DeviceManagementManagedDevices.Read.All',
  'SecurityIncident.Read.All',
  'SecurityAlert.Read.All',
  'IdentityRiskyUser.Read.All',
] as const;

/** Portal roles (§5.3) — app roles on the Read app, each backed by a security group. */
export const PORTAL_ROLES = [
  {
    value: 'Portal.Reader',
    displayName: 'Portal reader',
    description: 'View pages, dashboards, and reports; dry-run playbooks.',
  },
  {
    value: 'Portal.Operator',
    displayName: 'Portal operator',
    description: 'Arm write access and run write playbooks.',
  },
  { value: 'Playbook.Author', displayName: 'Playbook author', description: 'Draft and test content.' },
  {
    value: 'Playbook.Approver',
    displayName: 'Playbook approver',
    description: 'Approve runs and publishing of write-capable content.',
  },
  {
    value: 'Portal.Admin',
    displayName: 'Portal admin',
    description: 'Appearance, connections, audit export, scope drift.',
  },
] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number]['value'];

/** App role id that means "default access" (apps without, or not using, app roles). */
export const DEFAULT_ACCESS_ROLE_ID = '00000000-0000-0000-0000-000000000000';

/** Built-in Azure RBAC "Reader". */
export const AZURE_READER_ROLE_ID = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';

/** Built-in Entra directory role template ids (identical in every tenant). */
export const DIRECTORY_ROLES = {
  'User Administrator': 'fe930be7-5e62-47db-91af-98c3a49a38b1',
  'Groups Administrator': 'fdd7a751-b60b-444a-984c-02652fe8fa1c',
  'Global Reader': 'f2ef992c-3afb-46b9-b7cf-a126ee74c451',
} as const;
export type DirectoryRoleName = keyof typeof DIRECTORY_ROLES;

/** Tag that makes a service principal show up under "Enterprise applications". */
export const ENTERPRISE_APP_TAG = 'WindowsAzureActiveDirectoryIntegratedApp';

export const SECRET_LIFETIME_DAYS = 180;
