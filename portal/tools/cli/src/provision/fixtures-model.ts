/**
 * The licensed test fixtures of `provision test-identities` (opt-in, test environments only): the data model shared by
 * the plan (provision/fixtures-plan.ts, approver-plan.ts), the Graph I/O (fixtures-io.ts, approver-io.ts) and the
 * command (commands/test-fixtures.ts). Types, names and small pure rules only — no I/O, no planning.
 *
 * The fixtures give the live suite data that only a licensed tenant has:
 *   - `licences` (AF_TEST_LICENCE_SKU): a licence for the validation user and AF-Test-User-01..03 (mailboxes,
 *     OneDrives, Teams settings, PIM activation);
 *   - `pim`: AF-Test-User-01 and the validation user eligible (never active) for a read-only directory role;
 *   - `named-location`: AF-Test-Location, the documentation range 192.0.2.0/24, not trusted;
 *   - `intune`: a Windows compliance policy and configuration profile assigned to AF-Test-Group-01;
 *   - `approver`: a second validation account, "AF Tester 2", that holds only the Playbook.Approver portal role.
 * Opt-in: nothing here is planned unless AF_TEST_LICENCE_SKU is set or AF_TEST_FIXTURES names the fixture.
 *
 * Ownership: provisioning only changes or removes objects it created — users with the validation marker
 * (employeeType "AdminForge validation") or provisioning's display name, Intune policies whose description carries
 * the marker, the named location with exactly provisioning's range. A same-named object without that is refused.
 */
import { TEST_FIXTURE_NAMES } from '@adminforge/config';
import type { PortalRole } from './catalog';
import type { GraphGroup, Action } from './model';
import {
  APPROVER_MARKER,
  TESTER_MARKER,
  type GraphUser,
  type RegistrationCampaign,
  type TesterRoleGrant,
  type UserSpec,
} from './identities-plan';

export { APPROVER_MARKER } from './identities-plan';

/** Fixtures named in AF_TEST_FIXTURES (comma-separated). Licences are opted into with AF_TEST_LICENCE_SKU instead. */
/** The same list `tenantValues` exempts as AF_TEST_FIXTURES' value (@adminforge/config): one source. */
export const FIXTURE_NAMES = TEST_FIXTURE_NAMES;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
export type FixtureKey = 'licences' | FixtureName;

/**
 * Microsoft Graph application permissions the provisioner needs for each fixture. Its directory role (Global
 * Administrator while provisioning) does not cover these APIs app-only — `assignLicense` answers 403 without
 * LicenseAssignment.ReadWrite.All, and PIM, Conditional Access and Intune document application permissions only.
 * The approver is a user, groups and the registration campaign: covered like the validation user.
 */
export const FIXTURE_PERMISSIONS: Readonly<Record<FixtureKey, readonly string[]>> = {
  licences: ['LicenseAssignment.ReadWrite.All'],
  pim: ['RoleEligibilitySchedule.ReadWrite.Directory'],
  'named-location': ['Policy.Read.All', 'Policy.ReadWrite.ConditionalAccess'],
  intune: ['DeviceManagementConfiguration.ReadWrite.All'],
  approver: [],
};

/** Broader Graph application permissions that include a fixture's (Microsoft's documented alternatives). */
const BROADER: Readonly<Record<string, readonly string[]>> = {
  'LicenseAssignment.ReadWrite.All': ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  'RoleEligibilitySchedule.ReadWrite.Directory': ['RoleManagement.ReadWrite.Directory'],
};

/**
 * Graph application permissions that exist on the provisioner only for test fixtures (and the Teams test objects:
 * Team.Create). They survive removing its directory role, and several are tier-0 (PIM eligibility, Conditional
 * Access, Intune configuration): `provision status` warns while the provisioner's token holds any of them.
 */
export const STANDING_FIXTURE_PERMISSIONS: readonly string[] = [
  ...new Set([...Object.values(FIXTURE_PERMISSIONS).flat(), ...Object.values(BROADER).flat(), 'Team.Create']),
].sort();

/** Pure: the standing fixture permissions in a token's roles. */
export const standingFixturePermissions = (roles: readonly string[]) =>
  STANDING_FIXTURE_PERMISSIONS.filter((p) => roles.includes(p));

/** Whether a token's roles include `permission` or a broader one. */
export const heldPermission = (roles: readonly string[], permission: string) =>
  roles.includes(permission) || (BROADER[permission] ?? []).some((p) => roles.includes(p));

/** How to opt out of a fixture (for messages). */
export const optOut = (fixture: FixtureKey) =>
  fixture === 'licences' ? 'unset AF_TEST_LICENCE_SKU' : `remove "${fixture}" from AF_TEST_FIXTURES`;

/** The message for a fixture Graph refused (401/403): which permission the provisioner needs. */
export function permissionHint(fixture: FixtureKey): string {
  const perms = FIXTURE_PERMISSIONS[fixture];
  return perms.length
    ? `the provisioner may not do this: grant it the Microsoft Graph application permission ${perms.join(' and ')} (with admin consent), or ${optOut(fixture)}`
    : `the provisioner may not do this: give it Global Administrator while provisioning, or ${optOut(fixture)}`;
}

/**
 * Read-only directory roles the PIM fixture makes people eligible for (Microsoft's well-known template ids).
 * Reports Reader for AF-Test-User-01 (the PIM pages show an eligible assignment of a target user). Message Center
 * Reader for the validation user: activating it in the live suite exercises activation end to end without adding
 * access — the validation user already reads everything as Global Reader — and it is a different role from the
 * target's, so the pages show two.
 */
export const FIXTURE_ROLES = {
  'Reports Reader': '4a5d8f65-41da-4de4-8968-e035b65339cf',
  'Message Center Reader': '790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b',
} as const;
export type FixtureRoleName = keyof typeof FIXTURE_ROLES;

/** The named location: the documentation range (RFC 5737), so it can never match a real sign-in. */
export const NAMED_LOCATION = { displayName: 'AF-Test-Location', cidr: '192.0.2.0/24' } as const;

/** Description of the Intune fixtures — carries the marker that makes them provisioning's own. */
export const FIXTURE_DESCRIPTION = `${TESTER_MARKER} fixture, created by \`adminforge provision test-identities\`. Assigned to AF-Test-Group-01 only; safe to delete.`;

export type IntuneKind = 'compliance' | 'configuration';

/**
 * The Intune fixtures (Microsoft Graph v1.0). Harmless settings: the compliance policy requires only the Windows
 * firewall (on by default), the profile only blocks pop-ups in legacy Edge. Both apply to AF-Test-Group-01 only.
 */
export const INTUNE_POLICIES: Readonly<
  Record<IntuneKind, { path: string; displayName: string; body: Record<string, unknown> }>
> = {
  compliance: {
    path: '/deviceManagement/deviceCompliancePolicies',
    displayName: 'AF-Test Compliance (Windows)',
    body: {
      '@odata.type': '#microsoft.graph.windows10CompliancePolicy',
      displayName: 'AF-Test Compliance (Windows)',
      description: FIXTURE_DESCRIPTION,
      passwordRequired: false,
      activeFirewallRequired: true,
      // Graph requires the action for non-compliance on create: mark the device non-compliant (Intune's default).
      scheduledActionsForRule: [
        {
          ruleName: 'PasswordRequired',
          scheduledActionConfigurations: [
            {
              actionType: 'block',
              gracePeriodHours: 0,
              notificationTemplateId: '',
              notificationMessageCCList: [],
            },
          ],
        },
      ],
    },
  },
  configuration: {
    path: '/deviceManagement/deviceConfigurations',
    displayName: 'AF-Test Configuration (Windows)',
    body: {
      '@odata.type': '#microsoft.graph.windows10GeneralConfiguration',
      displayName: 'AF-Test Configuration (Windows)',
      description: FIXTURE_DESCRIPTION,
      edgeBlockPopups: true,
    },
  },
};

/** The second validation account's display name. */
export const APPROVER_DISPLAY_NAME = 'AF Tester 2';
/**
 * The approver's portal roles: Playbook.Approver to approve, Portal.Reader to sign in and see what it approves. Never
 * Operator, Author or Admin — it must not be able to run, write or change what it approves.
 */
export const APPROVER_PORTAL_ROLES: readonly PortalRole[] = ['Portal.Reader', 'Playbook.Approver'];

/** Opt-ins read from the env file (provision/fixtures-plan.ts `fixtureSettings`). */
export interface FixtureSettings {
  /** AF_TEST_LICENCE_SKU: a SKU part number (e.g. SPE_E5). Unset: no licence fixture. */
  licenceSku?: string;
  /** AF_TEST_FIXTURES. */
  fixtures: FixtureName[];
}

/** Whether any fixture is opted into. */
export const fixturesEnabled = (s: FixtureSettings) => !!s.licenceSku || s.fixtures.length > 0;

/** Whether `fixture` is opted into. */
export const wants = (s: FixtureSettings, fixture: FixtureKey) =>
  fixture === 'licences' ? !!s.licenceSku : s.fixtures.includes(fixture);

export interface DesiredFixtures {
  label: string;
  settings: FixtureSettings;
  tester: UserSpec;
  /** Who gets the licence: the validation user and AF-Test-User-01..03. */
  licensed: UserSpec[];
  /** PIM eligibility: who, for which role. */
  eligibility: Array<{ user: UserSpec; roleName: FixtureRoleName; roleDefinitionId: string }>;
  approver: UserSpec;
  testGroup: { uniqueName: string; displayName: string };
  /**
   * AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true for this label: scheduled writes can run, so two-person approval
   * protects real changes — the approver fixture (both passwords in one file) is refused here.
   */
  automationWrites: boolean;
}

/** A part of the state that couldn't be read; `forbidden` when Graph answered 401/403. */
export interface Unreadable {
  unreadable: string;
  forbidden?: boolean;
}
export const isUnreadable = (x: unknown): x is Unreadable =>
  !!x && typeof x === 'object' && 'unreadable' in (x as object);

export interface SkuInfo {
  skuId: string;
  skuPartNumber: string;
  capabilityStatus: string;
  consumedUnits: number;
  enabledUnits: number;
}

/** A test user as the fixtures read it (licences and usage location included). */
export interface FixtureUser extends GraphUser {
  usageLocation?: string | null;
  skuIds: string[];
}

export interface NamedLocationState {
  id: string;
  displayName: string;
  isTrusted: boolean;
  cidrs: string[];
}

export interface IntunePolicyState {
  id: string;
  displayName: string;
  description?: string | null;
  /** Its assignment targets: `@odata.type` (include/exclusion group, all devices, all users …) and the group. */
  targets: Array<{ type: string; groupId?: string }>;
}

/** The assignment target type for "include this group". */
export const GROUP_TARGET = '#microsoft.graph.groupAssignmentTarget';

/** Whether a policy is assigned to exactly one target: including `groupId`. Anything else is re-assigned. */
export const assignedOnlyTo = (p: IntunePolicyState, groupId: string | undefined) =>
  !!groupId &&
  p.targets.length === 1 &&
  p.targets[0]!.type === GROUP_TARGET &&
  p.targets[0]!.groupId === groupId;

/** A member of AF-Test-Group-01 (it receives the Intune fixtures). */
export interface GroupMember {
  type: string;
  userPrincipalName?: string;
  displayName?: string;
  employeeType?: string | null;
}

export interface ApproverState {
  user?: GraphUser;
  /** Groups the approver is a direct member of. */
  groupIds: string[];
  /** Its direct directory role assignments (any scope): it should hold none. */
  roleAssignments: Array<{ id: string; roleDefinitionId: string }>;
  /** Every directory role it holds, also through groups (identities-io `readTesterRoleGrants`). */
  roleGrants?: TesterRoleGrant[] | { unreadable: string };
  portalGroups: Partial<Record<PortalRole, GraphGroup>>;
  registrationCampaign?: RegistrationCampaign | { unreadable: string };
  env: { upn?: string; password?: string };
}

export interface FixtureState {
  /** The SKU named by AF_TEST_LICENCE_SKU; null when it is not a subscription of the tenant. Licences only. */
  sku?: SkuInfo | null | Unreadable;
  /** Test users by lower-case UPN (licensed and PIM users); undefined = does not exist (yet). */
  users: Record<string, FixtureUser | undefined>;
  /** Eligible role assignments (directory scope and role) by lower-case UPN. PIM only. */
  eligibility?: Record<string, Array<{ roleDefinitionId: string; directoryScopeId: string }>> | Unreadable;
  namedLocations?: NamedLocationState[] | Unreadable;
  intune?: Record<IntuneKind, IntunePolicyState[]> | Unreadable;
  testGroupId?: string;
  /** Members of AF-Test-Group-01 (Intune only). */
  testGroupMembers?: GroupMember[] | Unreadable;
  /** The approver: fully read when the fixture is opted in, otherwise only whether a leftover account exists. */
  approver?: ApproverState;
}

interface OpBase {
  action: Action;
  section: string;
  title: string;
  changes?: string[];
  detail?: string;
  fixture: FixtureKey;
  /** Opted in but can't be done (missing permission, refused object, no seat): ✗ in `provision status`. */
  blocked?: boolean;
}

export type FixtureOp = OpBase &
  (
    | { kind: 'note' }
    | { kind: 'licence'; upn: string; skuId: string }
    | { kind: 'licenceRemove'; upn: string; skuId: string }
    | { kind: 'eligibility'; upn: string; roleDefinitionId: string }
    | { kind: 'eligibilityRemove'; upn: string; roleDefinitionId: string }
    | { kind: 'namedLocation' }
    | { kind: 'namedLocationRemove'; id: string }
    | { kind: 'intunePolicy'; policy: IntuneKind; existingId?: string }
    | { kind: 'intunePolicyRemove'; policy: IntuneKind; id: string }
    | { kind: 'approver'; mode: 'create' | 'resetPassword'; user: UserSpec }
    | { kind: 'approverMembership'; role: PortalRole }
    | { kind: 'approverMembershipRemove'; role: PortalRole }
    | { kind: 'approverRoleRemove'; assignmentIds: string[] }
    | { kind: 'approverCampaignExclusion' }
    | { kind: 'approverRemove'; id: string }
  );

const localPart = (upn: string) => upn.split('@')[0]!;

/**
 * Whether an existing account is the one provisioning created for `spec`: an `af-` UPN and either the validation
 * marker or provisioning's display name. Anything else is someone's account; fixtures never touch it.
 */
export const isProvisionedAccount = (
  spec: Pick<UserSpec, 'displayName'>,
  user: Pick<GraphUser, 'userPrincipalName' | 'displayName' | 'employeeType'>,
) =>
  /^af-/i.test(localPart(user.userPrincipalName)) &&
  user.employeeType !== APPROVER_MARKER &&
  (user.employeeType === TESTER_MARKER || user.displayName === spec.displayName);

/** Whether a named location is provisioning's: exactly its name and range, not trusted. */
export const isProvisionedLocation = (l: NamedLocationState) =>
  l.displayName === NAMED_LOCATION.displayName &&
  !l.isTrusted &&
  l.cidrs.length === 1 &&
  l.cidrs[0] === NAMED_LOCATION.cidr;

/** Whether an Intune policy is provisioning's: an AF-Test name and the marker in its description. */
export const isProvisionedPolicy = (p: Pick<IntunePolicyState, 'displayName' | 'description'>) =>
  p.displayName.startsWith('AF-Test') && (p.description ?? '').includes(TESTER_MARKER);
