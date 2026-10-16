/**
 * The test-identities plan (test environments only, AF_TEST_IDENTITY_LABELS): the validation user the live suite
 * signs in as (portal role groups, the directory roles it needs, excluded from the MFA registration campaign) and the
 * AF-Test-User-0n / AF-Test-Group-01 write-test targets.
 *
 * Pure: desired identities (`buildDesiredIdentities`, from the label, domain and licensed workloads) + fetched state
 * (provision/identities-io.ts) → operations (`planIdentities`). Also the safety rules: an existing account at
 * AF_TEST_USER_UPN that provisioning did not create is refused, never modified (`testerRefusal`), and roles the
 * validation user holds beyond the managed ones are reported (`unexpectedTesterRoles`).
 */
import { DIRECTORY_ROLES, PORTAL_ROLES, type DirectoryRoleName, type PortalRole } from './catalog';
import { groupNames } from './entra-desired';
import type { Action, GraphGroup, GroupBody, Section } from './model';

export interface UserSpec {
  upn: string;
  displayName: string;
  mailNickname: string;
}

export interface DesiredIdentities {
  label: string;
  tester: UserSpec;
  /** Portal roles the live suite needs (tests/live/e2e): read pages, arm and write, verify the audit chain. */
  testerGroups: PortalRole[];
  /** Directory roles the live suite needs: read everything (Global Reader) and disable/enable a test user. */
  testerRoles: DirectoryRoleName[];
  /**
   * Service admin roles the tenant's licences would allow but AF_TEST_SERVICE_ADMIN_ROLES doesn't opt into: not
   * granted (and removed if held); the plan lists them as withheld.
   */
  withheldRoles: DirectoryRoleName[];
  targets: UserSpec[];
  testGroup: { uniqueName: string; body: GroupBody };
  /**
   * The approver fixture's UPN (AF_TEST_APPROVER_UPN, default af-approver@<domain>): the validation user and the
   * approver must be two accounts, so the same UPN is refused for both.
   */
  approverUpn?: string;
}

export interface GraphUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  accountEnabled?: boolean;
  /** Set to TESTER_MARKER on the validation user when provisioning creates it. */
  employeeType?: string | null;
}

/** A directory role the validation user holds, however it got it (for `provision status`). */
export interface TesterRoleGrant {
  roleDefinitionId: string;
  /** The role's display name, when it could be read. */
  name?: string;
  /** Directory scope: `/` (tenant-wide), an administrative unit, an application, … */
  scope: string;
  /** `direct`: assigned to the user; `group`: held through a role-assignable group (transitive membership). */
  via: 'direct' | 'group';
}

export interface IdentityState {
  tester?: GraphUser;
  /** Ids of groups the tester is a direct member of. */
  testerGroupIds: string[];
  /** Role definition ids assigned to the tester at directory scope "/". */
  testerRoleIds: string[];
  /** The tester's directory-scope role assignments (ids are needed to remove one). */
  testerRoleAssignments?: Array<{ id: string; roleDefinitionId: string }>;
  /**
   * Every directory role the tester holds — any scope, directly or through a group — or why they couldn't all be
   * read. Absent: not read.
   */
  testerRoleGrants?: TesterRoleGrant[] | { unreadable: string };
  portalGroups: Partial<Record<PortalRole, GraphGroup>>;
  targets: Record<string, GraphUser | undefined>;
  testGroup?: GraphGroup;
  /** Owners (object ids) of the AF-Test group. */
  testGroupOwnerIds?: string[];
  /**
   * Entra's authentication-methods registration campaign (the "sign in faster with your face, fingerprint or PIN"
   * nudge), or why it couldn't be read. Absent: not read (no exclusion is planned).
   */
  registrationCampaign?: RegistrationCampaign | { unreadable: string };
  env: { upn?: string; password?: string };
}

/** The part of the registration campaign the plan compares against (from `/policies/authenticationMethodsPolicy`). */
export interface RegistrationCampaign {
  /** `default` (Microsoft-managed), `enabled` or `disabled`. */
  state?: string;
  excludeTargets: Array<{ id: string; targetType?: string }>;
}

interface Base {
  action: Action;
  section: Section;
  title: string;
  changes?: string[];
  detail?: string;
}

export type IdentityOp =
  | (Base & {
      kind: 'tester';
      mode: 'create' | 'resetPassword' | 'none';
      user: UserSpec;
      /** Set when provisioning refuses to touch the account at AF_TEST_USER_UPN (nothing is applied then). */
      refused?: string;
    })
  | (Base & { kind: 'membership'; role: PortalRole })
  | (Base & { kind: 'membershipRemove'; role: PortalRole })
  | (Base & { kind: 'directoryRole'; roleName: DirectoryRoleName; roleDefinitionId: string })
  | (Base & { kind: 'directoryRoleRemove'; roleName: DirectoryRoleName; assignmentIds: string[] })
  | (Base & { kind: 'target'; user: UserSpec })
  | (Base & { kind: 'testGroup'; uniqueName: string; body: GroupBody })
  | (Base & { kind: 'testGroupOwner'; uniqueName: string })
  | (Base & { kind: 'campaignExclusion' })
  | (Base & { kind: 'skipped' });

const localPart = (upn: string) => upn.split('@')[0]!;

/** The validation user's display name, set by provisioning. */
export const TESTER_DISPLAY_NAME = 'AF Tester';
/** `employeeType` provisioning sets on the validation user when it creates it. */
export const TESTER_MARKER = 'AdminForge validation';
/**
 * `employeeType` of the approver test fixture ("AF Tester 2", provision/approver-plan.ts). Its own marker: the
 * validation user's checks never accept an approver account, and the approver's never accept the validation user.
 */
export const APPROVER_MARKER = 'AdminForge validation approver';

/** Why AF_TEST_USER_UPN can't be the validation user's UPN, if it can't: validation accounts are `af-…`. */
export function testerUpnProblem(upn: string): string | undefined {
  return /^af-/i.test(localPart(upn))
    ? undefined
    : 'AF_TEST_USER_UPN must start with "af-" (validation accounts are af-…); provisioning only manages accounts it created';
}

/**
 * Whether an existing account is the validation user provisioning created: its UPN starts with `af-` and it carries
 * the marker set at creation (employeeType "AdminForge validation") or the display name provisioning gives it
 * ("AF Tester"). Anything else is someone's account behind a mistyped AF_TEST_USER_UPN: provisioning never resets
 * its password, changes its roles or groups, excludes it from the registration campaign, enables or disables it.
 */
export function isProvisionedTester(
  user: Pick<GraphUser, 'userPrincipalName' | 'displayName' | 'employeeType'>,
) {
  return (
    !testerUpnProblem(user.userPrincipalName) &&
    user.employeeType !== APPROVER_MARKER &&
    (user.employeeType === TESTER_MARKER || user.displayName === TESTER_DISPLAY_NAME)
  );
}

/**
 * Whether an existing account is the approver fixture provisioning created: an `af-` UPN and the approver marker
 * (nothing else — no display-name fallback). The one rule for planning, applying, enabling, disabling and removing it.
 */
export const isProvisionedApprover = (user: Pick<GraphUser, 'userPrincipalName' | 'employeeType'>) =>
  !testerUpnProblem(user.userPrincipalName) && user.employeeType === APPROVER_MARKER;

/** Why the validation user and the approver can't have these UPNs: they must be two different accounts. */
export const sameAccountProblem = (testerUpn: string, approverUpn: string | undefined) =>
  approverUpn && testerUpn.toLowerCase() === approverUpn.toLowerCase()
    ? 'AF_TEST_USER_UPN and AF_TEST_APPROVER_UPN name the same account — the validation user and the approver must be two different accounts (two-person approval)'
    : undefined;

/** Why provisioning won't touch the account at AF_TEST_USER_UPN, if it won't. */
export function testerRefusal(
  upn: string,
  existing: GraphUser | undefined,
  approverUpn?: string,
): string | undefined {
  const upnProblem = testerUpnProblem(upn) ?? sameAccountProblem(upn, approverUpn);
  if (upnProblem) return upnProblem;
  if (existing && !isProvisionedTester(existing))
    return `the account at AF_TEST_USER_UPN was not created by AdminForge provisioning (its display name isn't "${TESTER_DISPLAY_NAME}" and it has no "${TESTER_MARKER}" marker) — refusing to change it; point AF_TEST_USER_UPN at the validation account, or remove the key to use af-tester@<AF_PRIMARY_DOMAIN>`;
  return undefined;
}

const CAMPAIGN_STATES: Record<string, string> = {
  default: 'Microsoft-managed',
  enabled: 'enabled',
  disabled: 'disabled',
};

/**
 * Portal roles of the validation user. The live suite reads every page (Reader), arms and runs reversible writes
 * (Operator) and verifies the audit chain and admin pages (Admin). Playbook.Author gates nothing yet; approval tests
 * need a second person, so the tester is never an approver (it could otherwise approve its own scheduled writes).
 */
export const TESTER_PORTAL_ROLES: readonly PortalRole[] = [
  'Portal.Reader',
  'Portal.Operator',
  'Portal.Admin',
];

/**
 * Directory roles of the validation user. Global Reader lets pages render; User Administrator lets the live suite
 * disable/re-enable AF-Test-User-02. Groups Administrator is deliberately not held: the tester owns AF-Test-Group-01
 * instead (enough to add and remove its members), so it can't add itself to other groups through that role.
 */
export const TESTER_DIRECTORY_ROLES: readonly DirectoryRoleName[] = ['User Administrator', 'Global Reader'];

/**
 * Extra roles so the live suite can run the Exchange and SharePoint write playbooks against the AF-Test-* mailboxes,
 * lists and sites (reads need only Global Reader). Opt-in: only with AF_TEST_SERVICE_ADMIN_ROLES=true (admin file)
 * and only where the tenant licenses the workload. Without the opt-in or the licence, re-provisioning removes them.
 * They are tenant-wide service admin roles (every mailbox / every site), which is why the account stays disabled
 * between live runs.
 */
export const TESTER_SERVICE_ROLES: Readonly<Record<'exchange' | 'sharepoint', DirectoryRoleName>> = {
  exchange: 'Exchange Recipient Administrator',
  sharepoint: 'SharePoint Administrator',
};

/** Licensed workloads, from the service plans of the tenant's active subscriptions (`/subscribedSkus`). */
export function licensedServices(servicePlans: readonly string[]): {
  exchange: boolean;
  sharepoint: boolean;
} {
  const plans = new Set(servicePlans.map((p) => p.toUpperCase()));
  const any = (names: string[]) => names.some((n) => plans.has(n));
  return {
    exchange: any([
      'EXCHANGE_S_STANDARD',
      'EXCHANGE_S_ENTERPRISE',
      'EXCHANGE_S_DESKLESS',
      'EXCHANGE_S_ESSENTIALS',
    ]),
    sharepoint: any(['SHAREPOINTSTANDARD', 'SHAREPOINTENTERPRISE', 'SHAREPOINT_S_DEVELOPER']),
  };
}

/** Pure: who and what `provision test-identities` maintains. */
export function buildDesiredIdentities(opts: {
  label: string;
  domain: string;
  testerUpn?: string;
  /** Licensed workloads (licensedServices). */
  services?: { exchange?: boolean; sharepoint?: boolean };
  /** AF_TEST_SERVICE_ADMIN_ROLES=true: the tester gets the licensed workloads' service admin roles. Default off. */
  serviceAdminRoles?: boolean;
  /** AF_TEST_APPROVER_UPN (default af-approver@<domain>), for the two-accounts check. */
  approverUpn?: string;
}): DesiredIdentities {
  const upn = opts.testerUpn || `af-tester@${opts.domain}`;
  const licensed = (['exchange', 'sharepoint'] as const)
    .filter((w) => opts.services?.[w])
    .map((w) => TESTER_SERVICE_ROLES[w]);
  return {
    label: opts.label,
    tester: {
      upn,
      displayName: TESTER_DISPLAY_NAME,
      mailNickname: localPart(upn).replace(/[^A-Za-z0-9._-]/g, ''),
    },
    testerGroups: [...TESTER_PORTAL_ROLES],
    testerRoles: [...TESTER_DIRECTORY_ROLES, ...(opts.serviceAdminRoles ? licensed : [])],
    withheldRoles: opts.serviceAdminRoles ? [] : licensed,
    targets: [1, 2, 3].map((n) => ({
      upn: `af-test-user-0${n}@${opts.domain}`,
      displayName: `AF-Test-User-0${n}`,
      mailNickname: `af-test-user-0${n}`,
    })),
    approverUpn: opts.approverUpn || `af-approver@${opts.domain}`,
    testGroup: {
      uniqueName: 'af-test-group-01',
      body: {
        displayName: 'AF-Test-Group-01',
        description:
          'AdminForge write-test target. Safe to modify; created by `adminforge provision test-identities`.',
        mailEnabled: false,
        mailNickname: 'af-test-group-01',
        securityEnabled: true,
        groupTypes: [],
      },
    },
  };
}

/** Pure: desired test identities + fetched state → operations. */
export function planIdentities(desired: DesiredIdentities, state: IdentityState): IdentityOp[] {
  const ops: IdentityOp[] = [];
  const { tester } = desired;
  const envMatches = state.env.upn?.toLowerCase() === tester.upn.toLowerCase();
  const refused = testerRefusal(tester.upn, state.tester, desired.approverUpn);

  if (refused) {
    // Nothing that touches this account is planned: no password, groups, roles, ownership or campaign exclusion.
    ops.push({
      kind: 'tester',
      mode: 'none',
      action: 'skip',
      section: 'Test identities',
      title: `${tester.displayName} (AF_TEST_USER_UPN)`,
      changes: [refused],
      user: tester,
      refused,
    });
    for (const user of desired.targets)
      ops.push({
        kind: 'target',
        action: state.targets[user.upn.toLowerCase()] ? 'noop' : 'create',
        section: 'Write-test targets',
        title: `${user.displayName} (user)`,
        user,
      });
    ops.push({
      kind: 'testGroup',
      action: state.testGroup ? 'noop' : 'create',
      section: 'Write-test targets',
      title: `${desired.testGroup.body.displayName} (security group)`,
      uniqueName: desired.testGroup.uniqueName,
      body: desired.testGroup.body,
    });
    return ops;
  }

  if (!state.tester)
    ops.push({
      kind: 'tester',
      mode: 'create',
      action: 'create',
      section: 'Test identities',
      title: `${tester.displayName} (AF_TEST_USER_UPN)`,
      changes: ['created disabled: `provision test-identities --enable` before a live run'],
      user: tester,
    });
  else if (!state.env.password || !envMatches)
    ops.push({
      kind: 'tester',
      mode: 'resetPassword',
      action: 'update',
      section: 'Test identities',
      title: `${tester.displayName} (AF_TEST_USER_UPN)`,
      changes: [
        !envMatches ? 'AF_TEST_USER_UPN not in env file' : 'AF_TEST_USER_PASSWORD not in env file',
        'a new password will be set and stored',
      ],
      user: tester,
    });
  else
    ops.push({
      kind: 'tester',
      mode: 'none',
      action: 'noop',
      section: 'Test identities',
      title: `${tester.displayName} (AF_TEST_USER_UPN)`,
      detail: `account ${state.tester.accountEnabled === false ? 'disabled' : 'enabled'}`,
      user: tester,
    });

  // Entra's registration campaign interrupts sign-in with a page headless Chrome can't complete. Only the validation
  // user is excluded; who the campaign targets, its state and snooze stay as the tenant set them.
  const campaign = state.registrationCampaign;
  if (campaign) {
    const title = `${tester.displayName} excluded from the authentication methods registration campaign (sign-in nudge)`;
    if ('unreadable' in campaign)
      ops.push({
        kind: 'campaignExclusion',
        action: 'skip',
        section: 'Test identities',
        title,
        changes: [campaign.unreadable],
      });
    else {
      const testerId = state.tester?.id.toLowerCase();
      const excluded = !!testerId && campaign.excludeTargets.some((t) => t.id.toLowerCase() === testerId);
      ops.push({
        kind: 'campaignExclusion',
        action: excluded ? 'noop' : 'create',
        section: 'Test identities',
        title,
        ...(excluded
          ? {
              detail: `campaign ${CAMPAIGN_STATES[campaign.state ?? ''] ?? (campaign.state || 'state unknown')}`,
            }
          : {
              changes: [
                'its registration prompt stops unattended sign-in; only this user is added, the rest of the campaign is unchanged',
              ],
            }),
      });
    }
  }

  for (const role of desired.testerGroups) {
    const group = state.portalGroups[role];
    const title = `${tester.displayName} ∈ ${groupNames(desired.label, role).displayName}`;
    if (!group) {
      ops.push({
        kind: 'skipped',
        action: 'skip',
        section: 'Group membership',
        title,
        changes: ['portal group missing — run `adminforge provision entra` first'],
      });
      continue;
    }
    const member = !!state.tester && state.testerGroupIds.includes(group.id);
    ops.push({
      kind: 'membership',
      action: member ? 'noop' : 'create',
      section: 'Group membership',
      title,
      role,
    });
  }
  // Portal roles the tester no longer needs (e.g. Playbook.Approver from earlier versions) are removed.
  for (const r of PORTAL_ROLES) {
    if (desired.testerGroups.includes(r.value)) continue;
    const group = state.portalGroups[r.value];
    if (!state.tester || !group || !state.testerGroupIds.includes(group.id)) continue;
    ops.push({
      kind: 'membershipRemove',
      action: 'delete',
      section: 'Group membership',
      title: `${tester.displayName} ∉ ${groupNames(desired.label, r.value).displayName}`,
      changes: ['not needed by the live suite'],
      role: r.value,
    });
  }

  const assignments =
    state.testerRoleAssignments ??
    state.testerRoleIds.map((roleDefinitionId) => ({ id: '', roleDefinitionId }));
  for (const roleName of desired.testerRoles) {
    const roleDefinitionId = DIRECTORY_ROLES[roleName];
    const has =
      !!state.tester && assignments.some((a) => a.roleDefinitionId.toLowerCase() === roleDefinitionId);
    ops.push({
      kind: 'directoryRole',
      action: has ? 'noop' : 'create',
      section: 'Directory roles',
      title: `${tester.displayName}: ${roleName} (directory scope /)`,
      roleName,
      roleDefinitionId,
    });
  }
  // Licensed service admin roles without the opt-in: listed as withheld (removed below if the tester holds one).
  for (const roleName of desired.withheldRoles) {
    const roleDefinitionId = DIRECTORY_ROLES[roleName];
    if (state.tester && assignments.some((a) => a.roleDefinitionId.toLowerCase() === roleDefinitionId))
      continue;
    ops.push({
      kind: 'skipped',
      action: 'skip',
      section: 'Directory roles',
      title: `${tester.displayName}: ${roleName} (directory scope /)`,
      changes: [
        'licensed, but a tenant-wide service admin role — set AF_TEST_SERVICE_ADMIN_ROLES=true in the admin file to let the live suite run the Exchange / SharePoint write playbooks',
      ],
    });
  }
  // Directory roles AdminForge used to give the tester and no longer wants (Groups Administrator) are removed.
  for (const [roleName, roleDefinitionId] of Object.entries(DIRECTORY_ROLES) as Array<
    [DirectoryRoleName, string]
  >) {
    if (desired.testerRoles.includes(roleName) || !state.tester) continue;
    const held = assignments.filter((a) => a.roleDefinitionId.toLowerCase() === roleDefinitionId);
    if (!held.length) continue;
    ops.push({
      kind: 'directoryRoleRemove',
      action: 'delete',
      section: 'Directory roles',
      title: `${tester.displayName}: ${roleName} (directory scope /)`,
      changes: [
        desired.withheldRoles.includes(roleName)
          ? 'service admin role without AF_TEST_SERVICE_ADMIN_ROLES=true'
          : 'standing role the live suite does not need',
      ],
      roleName,
      assignmentIds: held.map((a) => a.id).filter(Boolean),
    });
  }

  for (const user of desired.targets) {
    ops.push({
      kind: 'target',
      action: state.targets[user.upn.toLowerCase()] ? 'noop' : 'create',
      section: 'Write-test targets',
      title: `${user.displayName} (user)`,
      user,
    });
  }
  ops.push({
    kind: 'testGroup',
    action: state.testGroup ? 'noop' : 'create',
    section: 'Write-test targets',
    title: `${desired.testGroup.body.displayName} (security group)`,
    uniqueName: desired.testGroup.uniqueName,
    body: desired.testGroup.body,
  });
  const owner =
    !!state.tester && !!state.testGroup && (state.testGroupOwnerIds ?? []).includes(state.tester.id);
  ops.push({
    kind: 'testGroupOwner',
    action: owner ? 'noop' : 'create',
    section: 'Write-test targets',
    title: `${tester.displayName} owns ${desired.testGroup.body.displayName}`,
    uniqueName: desired.testGroup.uniqueName,
  });
  return ops;
}

const ROLE_NAMES = new Map(
  (Object.entries(DIRECTORY_ROLES) as Array<[DirectoryRoleName, string]>).map(([name, id]) => [id, name]),
);

/** Scope of a role assignment in words (never an id: administrative units and apps are tenant objects). */
const scopeWords = (scope: string) =>
  scope === '/'
    ? 'directory scope /'
    : scope.startsWith('/administrativeUnits/')
      ? 'an administrative unit'
      : 'a scoped assignment';

/**
 * Pure, for `provision status`: directory roles the validation user holds that provisioning neither grants nor plans
 * to remove — roles outside AdminForge's catalogue (Global Administrator, Privileged Role Administrator, custom
 * roles…), any role at a narrower scope, and any role held through a group. Names only, never ids.
 */
export function unexpectedTesterRoles(state: IdentityState): { lines: string[]; unknown?: string } {
  const grants = state.testerRoleGrants;
  if (!state.tester || !grants) return { lines: [] };
  if ('unreadable' in grants) return { lines: [], unknown: grants.unreadable };
  const lines = new Set<string>();
  for (const g of grants) {
    const id = g.roleDefinitionId.toLowerCase();
    const catalogued = ROLE_NAMES.has(id);
    // Direct, tenant-wide catalogue roles are planned (granted or removed) by planIdentities.
    if (catalogued && g.via === 'direct' && g.scope === '/') continue;
    const name = ROLE_NAMES.get(id) ?? g.name ?? 'a directory role whose name could not be read';
    lines.add(
      `${state.tester.displayName ?? TESTER_DISPLAY_NAME} holds ${name} (${scopeWords(g.scope)}${g.via === 'group' ? ', through a group' : ''}) — not granted by provisioning; remove it in the Entra admin centre`,
    );
  }
  return { lines: [...lines] };
}

/** Whether any test identity exists (for `provision status` in an environment that isn't a test label). */
export const testIdentitiesExist = (state: IdentityState) =>
  !!state.tester || !!state.testGroup || Object.values(state.targets).some(Boolean);
