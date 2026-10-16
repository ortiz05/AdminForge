/**
 * Microsoft Graph I/O for the `approver` test fixture (provision/approver-plan.ts decides): reads the approver
 * account, its group memberships, every directory role it holds (directly or through groups — the validation user's
 * reader, `readTesterRoleGrants`), the portal groups and the registration campaign; applies the approver's
 * operations. Its password goes to the admin env file through `writeEnv` (AF_TEST_APPROVER_UPN /
 * AF_TEST_APPROVER_PASSWORD), never to output. Only an account with the approver marker (`isProvisionedApprover`) is
 * changed or deleted; deleting it first takes it out of the registration campaign's exclusions.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { PORTAL_ROLES } from './catalog';
import { groupNames } from './entra-desired';
import { findGroup, odata } from './entra-io';
import type { ApproverState, DesiredFixtures, FixtureOp } from './fixtures-model';
import { APPROVER_MARKER, isProvisionedApprover, type GraphUser } from './identities-plan';
import {
  excludeFromRegistrationCampaign,
  findUser,
  readRegistrationCampaign,
  readTesterRoleGrants,
  removeFromRegistrationCampaignExclusions,
} from './identities-io';
import { generatePassword } from './password';

/**
 * Reads what the approver plan compares against. Read-only. `full: false` (the fixture isn't opted in) reads only
 * whether the account exists — enough to find a leftover approver or to remove it.
 */
export async function fetchApproverState(
  graph: GraphClient,
  desired: DesiredFixtures,
  env: ApproverState['env'],
  full = true,
): Promise<ApproverState> {
  const state: ApproverState = { groupIds: [], roleAssignments: [], portalGroups: {}, env };
  state.user = await findUser(graph, desired.approver.upn);
  if (!full) return state;
  // An account provisioning didn't create is left alone, its memberships and roles unread (the plan refuses it).
  if (state.user && isProvisionedApprover(state.user)) {
    state.groupIds = (
      await graph.all<{ id: string }>({ path: `/users/${state.user.id}/memberOf`, query: { $select: 'id' } })
    ).map((m) => m.id);
    const roles = await graph.all<{ id: string; roleDefinitionId: string; directoryScopeId: string }>({
      path: '/roleManagement/directory/roleAssignments',
      query: { $filter: `principalId eq ${odata(state.user.id)}` },
    });
    state.roleAssignments = roles.map((r) => ({ id: r.id, roleDefinitionId: r.roleDefinitionId }));
    state.roleGrants = await readTesterRoleGrants(graph, state.user.id, roles, "the approver's");
  }
  for (const r of PORTAL_ROLES) {
    const g = await findGroup(graph, groupNames(desired.label, r.value).uniqueName);
    if (g) state.portalGroups[r.value] = g;
  }
  state.registrationCampaign = await readRegistrationCampaign(graph);
  return state;
}

export interface ApproverApplyContext {
  graph: GraphClient;
  writeEnv: (updates: Record<string, string>) => void;
  log: (line: string) => void;
  /** Replication retry around calls on a just-created object. */
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
  password?: () => string;
}

const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 409 ||
    /already exist|conflicting object|same value for property/i.test(`${err.code} ${err.message}`));
const isMissing = (err: unknown) => err instanceof ApiError && err.status === 404;

/** The approver's id: created in this run, or read — only an account with the approver marker. */
async function approverId(ctx: ApproverApplyContext, desired: DesiredFixtures, known: GraphUser | undefined) {
  const user =
    known ??
    (await ctx.retry<GraphUser>(
      async () =>
        (await findUser(ctx.graph, desired.approver.upn)) ??
        Promise.reject(new ApiError(404, 'Request_ResourceNotFound', 'the approver is not visible yet')),
    ));
  if (!isProvisionedApprover(user))
    throw new ApiError(
      409,
      'NotProvisioned',
      'the approver account was not created by AdminForge provisioning; left alone',
    );
  return user.id;
}

/** Applies one approver operation (the account it creates is remembered in `state.user`). */
export async function applyApproverOp(
  op: FixtureOp,
  desired: DesiredFixtures,
  state: ApproverState,
  ctx: ApproverApplyContext,
): Promise<void> {
  const { graph, log } = ctx;
  const password = ctx.password ?? (() => generatePassword());
  switch (op.kind) {
    case 'approver': {
      const pwd = password();
      if (op.mode === 'create') {
        // Created disabled with the approver's own marker (never the validation user's).
        const created = await graph.request<GraphUser>({
          method: 'POST',
          path: '/users',
          body: {
            accountEnabled: false,
            displayName: op.user.displayName,
            mailNickname: op.user.mailNickname,
            userPrincipalName: op.user.upn,
            passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false },
            passwordPolicies: 'DisablePasswordExpiration',
            employeeType: APPROVER_MARKER,
          },
        });
        // Graph answers a create with the default properties only (no employeeType), so remember the marker we set:
        // the later steps of this run check it before touching the account.
        state.user = { ...created.data, employeeType: APPROVER_MARKER };
        log(`  ✓ created user: ${op.title}`);
      } else {
        const id = await approverId(ctx, desired, state.user);
        await ctx.retry(() =>
          graph.request({
            method: 'PATCH',
            path: `/users/${id}`,
            body: {
              passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false },
              passwordPolicies: 'DisablePasswordExpiration',
            },
          }),
        );
        log(`  ✓ set a new password for: ${op.title}`);
      }
      ctx.writeEnv({ AF_TEST_APPROVER_UPN: op.user.upn, AF_TEST_APPROVER_PASSWORD: pwd });
      log(
        '  ✓ wrote AF_TEST_APPROVER_UPN and AF_TEST_APPROVER_PASSWORD to the env file (password not shown)',
      );
      return;
    }
    case 'approverCampaignExclusion': {
      const id = await approverId(ctx, desired, state.user);
      const result = await ctx.retry(() => excludeFromRegistrationCampaign(graph, id));
      log(`  ✓ ${result === 'added' ? 'excluded' : 'already excluded'}: ${op.title}`);
      return;
    }
    case 'approverMembership': {
      const id = await approverId(ctx, desired, state.user);
      const gid = state.portalGroups[op.role]!.id;
      try {
        await ctx.retry(() =>
          graph.request({
            method: 'POST',
            path: `/groups/${gid}/members/$ref`,
            body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${id}` },
          }),
        );
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
      log(`  ✓ added: ${op.title}`);
      return;
    }
    case 'approverMembershipRemove': {
      const id = await approverId(ctx, desired, state.user);
      const gid = state.portalGroups[op.role]!.id;
      try {
        await graph.request({ method: 'DELETE', path: `/groups/${gid}/members/${id}/$ref` });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      log(`  ✓ removed: ${op.title}`);
      return;
    }
    case 'approverRoleRemove': {
      for (const a of op.assignmentIds)
        try {
          await graph.request({ method: 'DELETE', path: `/roleManagement/directory/roleAssignments/${a}` });
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      log(`  ✓ removed: ${op.title}`);
      return;
    }
    case 'approverRemove': {
      const id = await approverId(ctx, desired, state.user);
      // First out of the campaign's exclusions, so no exclusion outlives the account.
      const campaign = await removeFromRegistrationCampaignExclusions(graph, id);
      if (campaign === 'removed') log(`  ✓ removed from the registration campaign's exclusions: ${op.title}`);
      try {
        await graph.request({ method: 'DELETE', path: `/users/${id}` });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      ctx.writeEnv({ AF_TEST_APPROVER_PASSWORD: '', AF_TEST_APPROVER_TOTP_SECRET: '' });
      log(`  ✓ deleted: ${op.title} (password and TOTP seed cleared from the env file)`);
      return;
    }
    default:
      throw new Error(`not an approver operation: ${op.kind}`);
  }
}
