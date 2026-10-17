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
 *   - `approver`: a second validation account, "AF Tester 2", that holds only the Playbook.Approver portal role;
 *   - `ca-audit`: example Conditional Access policies, report-only — never enforced (provision/ca-audit-catalog.ts);
 *   - `directory`: AF-Test-User-04..12 with attributes and a manager chain, dynamic / nested / Microsoft 365 / empty /
 *     group-licensing groups and an administrative unit (provision/directory-fixture-*.ts);
 *   - `guest`: AF-Test-Guest-01, invited without an email, never redeemed (directory-fixture-plan.ts `planGuest`);
 *   - `apps`: app registrations with expiring, long-lived and many credentials, a risky one, an ownerless one and a
 *     SAML app — never granted anything (provision/apps-fixture-*.ts);
 *   - `auth-methods`: an SMS method (fictitious number) and a Temporary Access Pass (provision/auth-methods-fixture.ts);
 *   - `intune-more`: iOS, Android and macOS compliance, an update ring, app protection (intune-more-fixture.ts);
 *   - `sign-ins`: two accounts that only sign in (tests/live/scripts/generate-sign-ins.ts; sign-ins-fixture.ts).
 * Opt-in: nothing here is planned unless AF_TEST_LICENCE_SKU is set or AF_TEST_FIXTURES names the fixture.
 *
 * Ownership: provisioning only changes or removes objects it created — users with the validation marker
 * (employeeType "AdminForge validation") or provisioning's display name, Intune policies whose description carries
 * the marker, the named location with exactly provisioning's range, Conditional Access policies with a catalogue name
 * that are not on (enforced). A same-named object without that is refused.
 */
import { TEST_FIXTURE_NAMES } from '@adminforge/config';
import type { AppsState, AppsStep } from './apps-fixture-plan';
import type { AuthMethodsState, AuthMethodsStep } from './auth-methods-fixture';
import type { PortalRole } from './catalog';
import type { DirectoryCatalog } from './directory-fixture-catalog';
import type { DirectoryState, DirectoryStep } from './directory-fixture-plan';
import type { IntuneMoreState, IntuneMoreStep } from './intune-more-fixture';
import type { SignInAccountSpec, SignInsState, SignInsStep } from './sign-ins-fixture';
import type { GraphGroup, Action } from './model';
import {
  APPROVER_MARKER,
  TESTER_MARKER,
  isProvisionedTester,
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
  // Creating, updating and deleting policies. Graph also requires Application.Read.All to add or edit an application
  // condition (the Azure management policy names an app) — it answers 403 "Application.Read.All scope is required".
  // Role template ids and the authentication strength are well-known ids, so nothing else needs reading.
  'ca-audit': ['Policy.Read.All', 'Policy.ReadWrite.ConditionalAccess', 'Application.Read.All'],
  // Users, groups and the administrative unit are covered by the provisioner's directory role; group-based licensing
  // and inviting a guest are not, app-only.
  directory: ['LicenseAssignment.ReadWrite.All'],
  guest: ['User.Invite.All'],
  apps: [],
  'auth-methods': ['UserAuthenticationMethod.ReadWrite.All'],
  'intune-more': ['DeviceManagementConfiguration.ReadWrite.All', 'DeviceManagementApps.ReadWrite.All'],
  'sign-ins': [],
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

/**
 * Microsoft Graph permission names a refusal's message mentions (e.g. "Application.Read.All scope is required to
 * add/edit application condition"): `Resource.Action[.Qualifier]`, the action a Graph verb.
 */
export function namedPermissions(message: string): string[] {
  const found =
    message.match(
      /\b[A-Z][A-Za-z]+\.(?:Read|ReadWrite|ReadBasic|Write|Create|Manage|Send|Invite|Export|Import|Assign)[A-Za-z]*(?:\.[A-Z][A-Za-z]*)?\b/g,
    ) ?? [];
  return [...new Set(found)];
}

/**
 * The message for a fixture Graph refused (401/403). When Graph's message names a permission the fixture needs (one in
 * FIXTURE_PERMISSIONS — e.g. a policy with an application condition needs Application.Read.All), Graph's message
 * (masked by the caller, control characters removed) and that permission; it is more precise than the whole list.
 * Anything else Graph names is not trusted as advice: the fixture's own permissions then.
 */
export function refusalHint(fixture: FixtureKey, graphMessage: string): string {
  const named = namedPermissions(graphMessage).filter((p) => FIXTURE_PERMISSIONS[fixture].includes(p));
  // Control characters (C0, DEL, C1) become spaces: Graph's text reaches the terminal.
  const clean = [...graphMessage]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
    })
    .join('');
  return named.length
    ? `Graph: "${clean}" — grant the provisioner the Microsoft Graph application permission ${named.join(' or ')} (with admin consent), or ${optOut(fixture)}`
    : permissionHint(fixture);
}

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
  testGroup: { uniqueName: string; displayName: string; description: string };
  /**
   * AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true for this label: scheduled writes can run, so two-person approval
   * protects real changes — the approver fixture (both passwords in one file) is refused here.
   */
  automationWrites: boolean;
  /** AF_PROTECTED_USER_IDS (break-glass accounts): excluded from the ca-audit policies. */
  protectedUserIds: string[];
  /** The directory fixture's users, guest, groups and administrative unit. */
  directory: DirectoryCatalog;
  /** The sign-ins fixture's two accounts. */
  signIns: SignInAccountSpec[];
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
  /** Members of AF-Test-Group-01 (Intune and ca-audit: both target the group). */
  testGroupMembers?: GroupMember[] | Unreadable;
  /** Whether AF-Test-Group-01 uses dynamic membership (ca-audit: then anyone can end up in its policies' scope). */
  testGroupDynamic?: boolean | Unreadable;
  /** The approver: fully read when the fixture is opted in, otherwise only whether a leftover account exists. */
  approver?: ApproverState;
  /** Conditional Access policies (ca-audit only). */
  caPolicies?: CaPolicyState[] | Unreadable;
  directory?: DirectoryState | Unreadable;
  apps?: AppsState | Unreadable;
  authMethods?: AuthMethodsState | Unreadable;
  intuneMore?: IntuneMoreState | Unreadable;
  signIns?: SignInsState | Unreadable;
}

/** A Conditional Access policy as the ca-audit fixture reads it. */
export interface CaPolicyState {
  id: string;
  displayName: string;
  /** enabled (on, enforced), enabledForReportingButNotEnforced (report-only) or disabled (off). */
  state: string;
  conditions?: Record<string, unknown> | null;
  grantControls?: Record<string, unknown> | null;
  sessionControls?: Record<string, unknown> | null;
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
  /** A failure doesn't skip the fixture's later operations (each Conditional Access policy stands alone). */
  independent?: boolean;
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
    | { kind: 'caPolicy'; displayName: string; existingId?: string }
    | { kind: 'caPolicyRemove'; displayName: string; id: string }
    | { kind: 'directory'; step: DirectoryStep }
    | { kind: 'apps'; step: AppsStep }
    | { kind: 'authMethods'; step: AuthMethodsStep }
    | { kind: 'intuneMore'; step: IntuneMoreStep }
    | { kind: 'signIns'; step: SignInsStep }
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

/**
 * Pure: how many members of AF-Test-Group-01 are not provisioning's test accounts (the validation user,
 * AF-Test-User-0n) or AF-Test-* devices (the enrolled test device). The group receives the AF-Test Intune policies and
 * the group-scoped audit Conditional Access policies, so anyone else in it would get them too. A count, never names.
 */
export function unexpectedGroupMembers(members: readonly GroupMember[]): number {
  return members.filter((m) => {
    const type = m.type.toLowerCase();
    if (type.endsWith('.device')) return !(m.displayName ?? '').startsWith('AF-Test-');
    if (!type.endsWith('.user') || !m.userPrincipalName) return true;
    const user = {
      userPrincipalName: m.userPrincipalName,
      displayName: m.displayName,
      employeeType: m.employeeType,
    };
    const target =
      /^af-test-user-\d+@/i.test(m.userPrincipalName) && /^AF-Test-User-\d+$/.test(m.displayName ?? '');
    return !(isProvisionedTester(user) || target || isProvisionedAccount({ displayName: '' }, user));
  }).length;
}

/**
 * Whether a group is AF-Test-Group-01 as the test identities created it: its unique name, display name and
 * description. The enterprise fixtures nest it and assign policies to it only then.
 */
export const isProvisionedTestGroup = (
  d: Pick<DesiredFixtures, 'testGroup'>,
  g: { uniqueName?: string | null; displayName?: string; description?: string | null } | undefined,
) =>
  !!g &&
  g.uniqueName === d.testGroup.uniqueName &&
  g.displayName === d.testGroup.displayName &&
  (g.description ?? '') === d.testGroup.description;

/**
 * Why policies scoped to AF-Test-Group-01 can't target it now (ca-audit, intune-more), or undefined when they can:
 * whoever is in the group receives them, so it must hold only provisioning's test accounts and AF-Test-* devices, and
 * not use dynamic membership.
 */
export function testGroupProblem(
  s: Pick<FixtureState, 'testGroupMembers' | 'testGroupDynamic'>,
): string | undefined {
  const members = s.testGroupMembers;
  if (isUnreadable(members)) return `AF-Test-Group-01's members: ${members.unreadable}`;
  if (isUnreadable(s.testGroupDynamic))
    return `AF-Test-Group-01's membership type: ${s.testGroupDynamic.unreadable}`;
  if (s.testGroupDynamic)
    return 'AF-Test-Group-01 uses dynamic membership — anyone could fall into this policy; make it an assigned group';
  const others = members ? unexpectedGroupMembers(members) : 0;
  return others
    ? `AF-Test-Group-01 has ${others} member(s) that aren't provisioning's test accounts or AF-Test-* devices — remove them first`
    : undefined;
}

/** Whether an Intune policy is provisioning's: an AF-Test name and the marker in its description. */
export const isProvisionedPolicy = (p: Pick<IntunePolicyState, 'displayName' | 'description'>) =>
  p.displayName.startsWith('AF-Test') && (p.description ?? '').includes(TESTER_MARKER);
