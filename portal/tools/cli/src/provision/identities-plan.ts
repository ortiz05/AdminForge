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
  targets: UserSpec[];
  testGroup: { uniqueName: string; body: GroupBody };
}

export interface GraphUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  accountEnabled?: boolean;
}

export interface IdentityState {
  tester?: GraphUser;
  /** Ids of groups the tester is a direct member of. */
  testerGroupIds: string[];
  /** Role definition ids assigned to the tester at directory scope "/". */
  testerRoleIds: string[];
  /** The tester's directory-scope role assignments (ids are needed to remove one). */
  testerRoleAssignments?: Array<{ id: string; roleDefinitionId: string }>;
  portalGroups: Partial<Record<PortalRole, GraphGroup>>;
  targets: Record<string, GraphUser | undefined>;
  testGroup?: GraphGroup;
  /** Owners (object ids) of the AF-Test group. */
  testGroupOwnerIds?: string[];
  env: { upn?: string; password?: string };
}

interface Base {
  action: Action;
  section: Section;
  title: string;
  changes?: string[];
  detail?: string;
}

export type IdentityOp =
  | (Base & { kind: 'tester'; mode: 'create' | 'resetPassword' | 'none'; user: UserSpec })
  | (Base & { kind: 'membership'; role: PortalRole })
  | (Base & { kind: 'membershipRemove'; role: PortalRole })
  | (Base & { kind: 'directoryRole'; roleName: DirectoryRoleName; roleDefinitionId: string })
  | (Base & { kind: 'directoryRoleRemove'; roleName: DirectoryRoleName; assignmentIds: string[] })
  | (Base & { kind: 'target'; user: UserSpec })
  | (Base & { kind: 'testGroup'; uniqueName: string; body: GroupBody })
  | (Base & { kind: 'testGroupOwner'; uniqueName: string })
  | (Base & { kind: 'skipped' });

const localPart = (upn: string) => upn.split('@')[0]!;

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

/** Pure: who and what `provision test-identities` maintains. */
export function buildDesiredIdentities(opts: {
  label: string;
  domain: string;
  testerUpn?: string;
}): DesiredIdentities {
  const upn = opts.testerUpn || `af-tester@${opts.domain}`;
  return {
    label: opts.label,
    tester: { upn, displayName: 'AF Tester', mailNickname: localPart(upn).replace(/[^A-Za-z0-9._-]/g, '') },
    testerGroups: [...TESTER_PORTAL_ROLES],
    testerRoles: [...TESTER_DIRECTORY_ROLES],
    targets: [1, 2, 3].map((n) => ({
      upn: `af-test-user-0${n}@${opts.domain}`,
      displayName: `AF-Test-User-0${n}`,
      mailNickname: `af-test-user-0${n}`,
    })),
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
      changes: ['standing role the live suite does not need'],
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

/** Whether any test identity exists (for `provision status` in an environment that isn't a test label). */
export const testIdentitiesExist = (state: IdentityState) =>
  !!state.tester || !!state.testGroup || Object.values(state.targets).some(Boolean);
