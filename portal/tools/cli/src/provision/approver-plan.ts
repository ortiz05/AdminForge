/**
 * The `approver` test fixture: "AF Tester 2", a second validation account that holds only the Portal.Reader and
 * Playbook.Approver portal roles, so approval flows (mailbox forwarding, critical playbooks, write-capable schedules)
 * can be tested with two people — the validation user requests, the approver approves. No directory roles, created
 * disabled (`--enable --approver` turns it on, `--disable` always turns it off), excluded from the registration
 * campaign like the validation user. Its UPN and password go to the admin env file (AF_TEST_APPROVER_UPN / _PASSWORD).
 *
 * Both passwords then sit in one file, so "two people" is a test convenience, not a control: the fixture is refused
 * where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true (scheduled writes, whose two-person approval protects real changes)
 * and where the two UPNs are the same. An account is the approver only with the approver marker
 * (`isProvisionedApprover`); anything else at its UPN is refused, never modified. A marked approver left behind after
 * the fixture was opted out shows as ✗ in `provision status` until `--remove-fixtures` deletes it.
 *
 * Pure: desired (provision/fixtures-plan.ts) + state (provision/approver-io.ts) → operations.
 */
import { PORTAL_ROLES } from './catalog';
import { groupNames } from './entra-desired';
import {
  APPROVER_MARKER,
  APPROVER_PORTAL_ROLES,
  type ApproverState,
  type DesiredFixtures,
  type FixtureOp,
} from './fixtures-model';
import { isProvisionedApprover, sameAccountProblem, testerUpnProblem } from './identities-plan';

const SECTION = 'Test fixtures: approver';
const base = { fixture: 'approver', section: SECTION } as const;

/** Why provisioning won't touch the account at the approver's UPN (any operation, removal included), if it won't. */
export function approverOwnershipProblem(desired: DesiredFixtures, state: ApproverState): string | undefined {
  const { upn } = desired.approver;
  if (testerUpnProblem(upn))
    return 'AF_TEST_APPROVER_UPN must start with "af-" (validation accounts are af-…)';
  const same = sameAccountProblem(desired.tester.upn, upn);
  if (same) return same;
  if (state.user && !isProvisionedApprover(state.user))
    return `the account at the approver's UPN was not created by AdminForge provisioning (no "${APPROVER_MARKER}" marker) — refusing to change it; point AF_TEST_APPROVER_UPN at another af-… address`;
  return undefined;
}

/** Why provisioning won't create or update the approver here, if it won't. */
export function approverRefusal(desired: DesiredFixtures, state: ApproverState): string | undefined {
  if (desired.automationWrites)
    return 'refused: AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true for this label — two-person approval protects scheduled writes here, and the approver fixture keeps both testers’ passwords in one file; use it only in labels without automation writes (or remove "approver" from AF_TEST_FIXTURES)';
  return approverOwnershipProblem(desired, state);
}

/** Pure: the approver account, its two portal roles, no directory roles, the campaign exclusion. */
export function planApprover(desired: DesiredFixtures, state: ApproverState): FixtureOp[] {
  const { approver } = desired;
  const name = approver.displayName;
  const refused = approverRefusal(desired, state);
  if (refused)
    return [
      {
        ...base,
        kind: 'note',
        action: 'skip',
        blocked: true,
        title: `${name} (AF_TEST_APPROVER_UPN)`,
        changes: [refused],
      },
    ];

  const ops: FixtureOp[] = [];
  const envMatches = state.env.upn?.toLowerCase() === approver.upn.toLowerCase();
  if (!state.user)
    ops.push({
      ...base,
      kind: 'approver',
      mode: 'create',
      action: 'create',
      title: `${name} (AF_TEST_APPROVER_UPN)`,
      changes: ['created disabled: `provision test-identities --enable --approver` before a live run'],
      user: approver,
    });
  else if (!state.env.password || !envMatches)
    ops.push({
      ...base,
      kind: 'approver',
      mode: 'resetPassword',
      action: 'update',
      title: `${name} (AF_TEST_APPROVER_UPN)`,
      changes: [
        !envMatches ? 'AF_TEST_APPROVER_UPN not in env file' : 'AF_TEST_APPROVER_PASSWORD not in env file',
        'a new password will be set and stored',
      ],
      user: approver,
    });
  else
    ops.push({
      ...base,
      kind: 'note',
      action: 'noop',
      title: `${name} (AF_TEST_APPROVER_UPN)`,
      detail: `account ${state.user.accountEnabled === false ? 'disabled' : 'enabled'}`,
    });

  const campaign = state.registrationCampaign;
  if (campaign) {
    const title = `${name} excluded from the authentication methods registration campaign (sign-in nudge)`;
    if ('unreadable' in campaign)
      ops.push({ ...base, kind: 'note', action: 'skip', title, changes: [campaign.unreadable] });
    else {
      const id = state.user?.id.toLowerCase();
      const excluded = !!id && campaign.excludeTargets.some((t) => t.id.toLowerCase() === id);
      ops.push({
        ...base,
        kind: 'approverCampaignExclusion',
        action: excluded ? 'noop' : 'create',
        title,
        ...(excluded ? {} : { changes: ['its registration prompt stops unattended sign-in'] }),
      });
    }
  }

  for (const role of APPROVER_PORTAL_ROLES) {
    const group = state.portalGroups[role];
    const title = `${name} ∈ ${groupNames(desired.label, role).displayName}`;
    if (!group)
      ops.push({
        ...base,
        kind: 'note',
        action: 'skip',
        blocked: true,
        title,
        changes: ['portal group missing — run `adminforge provision entra` first'],
      });
    else
      ops.push({
        ...base,
        kind: 'approverMembership',
        action: state.user && state.groupIds.includes(group.id) ? 'noop' : 'create',
        title,
        role,
      });
  }
  // Operator, Author or Admin would let the approver run, write or change what it approves: removed.
  for (const r of PORTAL_ROLES) {
    if (APPROVER_PORTAL_ROLES.includes(r.value)) continue;
    const g = state.portalGroups[r.value];
    if (!state.user || !g || !state.groupIds.includes(g.id)) continue;
    ops.push({
      ...base,
      kind: 'approverMembershipRemove',
      action: 'delete',
      title: `${name} ∉ ${groupNames(desired.label, r.value).displayName}`,
      changes: ['the approver holds Portal.Reader and Playbook.Approver only'],
      role: r.value,
    });
  }

  if (!state.user) return ops;
  if (state.roleAssignments.length)
    ops.push({
      ...base,
      kind: 'approverRoleRemove',
      action: 'delete',
      title: `${name}: directory role assignments`,
      changes: [`${state.roleAssignments.length} held — the approver holds no directory roles`],
      assignmentIds: state.roleAssignments.map((a) => a.id),
    });
  // Roles through a (role-assignable) group can't be removed here without touching the group: shown, never changed.
  const grants = state.roleGrants;
  if (grants && 'unreadable' in grants)
    ops.push({
      ...base,
      kind: 'note',
      action: 'skip',
      title: `${name}: directory roles through groups`,
      changes: [grants.unreadable],
    });
  else
    for (const g of (grants ?? []).filter((x) => x.via === 'group'))
      ops.push({
        ...base,
        kind: 'note',
        action: 'skip',
        blocked: true,
        title: `${name}: ${g.name ?? 'a directory role whose name could not be read'} through a group`,
        changes: [
          'the approver holds no directory roles — take it out of that group in the Entra admin centre',
        ],
      });
  return ops;
}

/** Pure: a marked approver while the fixture isn't opted in — left over (✗ in `provision status`). */
export function planLeftoverApprover(desired: DesiredFixtures, state: ApproverState): FixtureOp[] {
  if (!state.user || !isProvisionedApprover(state.user)) return [];
  return [
    {
      ...base,
      kind: 'note',
      action: 'skip',
      blocked: true,
      title: `${desired.approver.displayName} (AF_TEST_APPROVER_UPN)`,
      changes: [
        'left over: "approver" is not in AF_TEST_FIXTURES — run `pnpm adminforge provision test-identities --remove-fixtures`',
      ],
    },
  ];
}

/** Pure: `--remove-fixtures` deletes the approver account (only provisioning's own), opted in or not. */
export function planApproverRemoval(desired: DesiredFixtures, state: ApproverState): FixtureOp[] {
  const title = `${desired.approver.displayName} (AF_TEST_APPROVER_UPN)`;
  if (!state.user) return [];
  const refused = approverOwnershipProblem(desired, state);
  if (refused) return [{ ...base, kind: 'note', action: 'skip', blocked: true, title, changes: [refused] }];
  return [
    {
      ...base,
      kind: 'approverRemove',
      action: 'delete',
      title,
      changes: [
        'takes it out of the registration campaign’s exclusions, deletes the account (restorable for 30 days under Deleted users) and clears AF_TEST_APPROVER_PASSWORD / AF_TEST_APPROVER_TOTP_SECRET',
      ],
      id: state.user.id,
    },
  ];
}
