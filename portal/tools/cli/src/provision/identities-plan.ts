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
  testerGroups: PortalRole[];
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
  portalGroups: Partial<Record<PortalRole, GraphGroup>>;
  targets: Record<string, GraphUser | undefined>;
  testGroup?: GraphGroup;
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
  | (Base & { kind: 'directoryRole'; roleName: DirectoryRoleName; roleDefinitionId: string })
  | (Base & { kind: 'target'; user: UserSpec })
  | (Base & { kind: 'testGroup'; uniqueName: string; body: GroupBody })
  | (Base & { kind: 'skipped' });

const localPart = (upn: string) => upn.split('@')[0]!;

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
    testerGroups: PORTAL_ROLES.map((r) => r.value),
    testerRoles: ['User Administrator', 'Groups Administrator', 'Global Reader'],
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

  for (const roleName of desired.testerRoles) {
    const roleDefinitionId = DIRECTORY_ROLES[roleName];
    const has = !!state.tester && state.testerRoleIds.some((id) => id.toLowerCase() === roleDefinitionId);
    ops.push({
      kind: 'directoryRole',
      action: has ? 'noop' : 'create',
      section: 'Directory roles',
      title: `${tester.displayName}: ${roleName} (directory scope /)`,
      roleName,
      roleDefinitionId,
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
  return ops;
}
