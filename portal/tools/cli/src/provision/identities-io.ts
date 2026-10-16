/**
 * Microsoft Graph I/O for `provision test-identities` and the test-identity part of `provision status`, as the
 * provisioner identity: reads the validation user, the AF-Test-* targets, group memberships, every directory role the
 * validation user holds (directly or through groups), the authentication-methods registration campaign and Security
 * Defaults; applies a plan's operations (`applyIdentityOps`) and turns the validation user's sign-in on or off
 * (`setUserEnabled`, which refuses any account provisioning did not create). The validation user's password goes to
 * the admin env file through `writeEnv`, never to output. Decides nothing: provision/identities-plan.ts does.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { findGroup, odata } from './entra-io';
import { groupNames } from './entra-desired';
import { PORTAL_ROLES } from './catalog';
import {
  isProvisionedTester,
  TESTER_MARKER,
  type DesiredIdentities,
  type GraphUser,
  type IdentityOp,
  type IdentityState,
  type RegistrationCampaign,
  type TesterRoleGrant,
} from './identities-plan';
import type { GraphGroup } from './model';
import { generatePassword } from './password';
import { withReplicationRetry, type RetryOptions } from './retry';

const USER_SELECT = 'id,userPrincipalName,displayName,accountEnabled,employeeType';
const notYetVisible = (what: string) =>
  new ApiError(404, 'Request_ResourceNotFound', `${what} is not visible yet (directory replication)`);

export async function findUser(graph: GraphClient, upn: string): Promise<GraphUser | undefined> {
  try {
    return (
      await graph.request<GraphUser>({
        path: `/users/${encodeURIComponent(upn)}`,
        query: { $select: USER_SELECT },
      })
    ).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** Reads everything the test-identities plan compares against. Read-only. */
export async function fetchIdentityState(
  graph: GraphClient,
  desired: DesiredIdentities,
  env: IdentityState['env'],
): Promise<IdentityState> {
  const state: IdentityState = { testerGroupIds: [], testerRoleIds: [], portalGroups: {}, targets: {}, env };
  state.tester = await findUser(graph, desired.tester.upn);
  // An account provisioning didn't create is left alone, its memberships and roles unread (the plan refuses it).
  if (state.tester && isProvisionedTester(state.tester)) {
    const memberOf = await graph.all<{ id: string }>({
      path: `/users/${state.tester.id}/memberOf`,
      query: { $select: 'id' },
    });
    state.testerGroupIds = memberOf.map((m) => m.id);
    const roles = await graph.all<{ id: string; roleDefinitionId: string; directoryScopeId: string }>({
      path: '/roleManagement/directory/roleAssignments',
      query: { $filter: `principalId eq ${odata(state.tester.id)}` },
    });
    state.testerRoleAssignments = roles
      .filter((r) => r.directoryScopeId === '/')
      .map((r) => ({ id: r.id, roleDefinitionId: r.roleDefinitionId }));
    state.testerRoleIds = state.testerRoleAssignments.map((r) => r.roleDefinitionId);
    state.testerRoleGrants = await readTesterRoleGrants(graph, state.tester.id, roles);
  }
  // Every portal group: the tester's memberships in groups it no longer needs are removed.
  for (const r of PORTAL_ROLES) {
    const g = await findGroup(graph, groupNames(desired.label, r.value).uniqueName);
    if (g) state.portalGroups[r.value] = g;
  }
  for (const t of desired.targets) state.targets[t.upn.toLowerCase()] = await findUser(graph, t.upn);
  state.testGroup = await findGroup(graph, desired.testGroup.uniqueName);
  if (state.testGroup)
    state.testGroupOwnerIds = (
      await graph.all<{ id: string }>({
        path: `/groups/${state.testGroup.id}/owners`,
        query: { $select: 'id' },
      })
    ).map((o) => o.id);
  state.registrationCampaign = await readRegistrationCampaign(graph);
  return state;
}

/**
 * Every directory role a validation account holds (the validation user; the approver fixture too): its own role
 * assignments at any scope, plus the directory roles it is a transitive member of (roles held through a
 * role-assignable group). Read-only; names are resolved for roles outside AdminForge's catalogue. A part that can't be
 * read makes the whole answer "unreadable" (status shows ⚠).
 */
export async function readTesterRoleGrants(
  graph: GraphClient,
  userId: string,
  direct: Array<{ roleDefinitionId: string; directoryScopeId: string }>,
  /** For the message when it can't be read. */
  whose = "the validation user's",
): Promise<TesterRoleGrant[] | { unreadable: string }> {
  const grants: TesterRoleGrant[] = direct.map((r) => ({
    roleDefinitionId: r.roleDefinitionId,
    scope: r.directoryScopeId || '/',
    via: 'direct',
  }));
  try {
    const roles = await graph.all<{ id: string; roleTemplateId?: string | null; displayName?: string }>({
      path: `/users/${userId}/transitiveMemberOf/microsoft.graph.directoryRole`,
      query: { $select: 'id,roleTemplateId,displayName' },
    });
    for (const r of roles) {
      const roleDefinitionId = (r.roleTemplateId ?? '').toLowerCase();
      if (!roleDefinitionId) continue;
      const assigned = grants.some(
        (g) => g.via === 'direct' && g.scope === '/' && g.roleDefinitionId.toLowerCase() === roleDefinitionId,
      );
      if (!assigned) grants.push({ roleDefinitionId, name: r.displayName, scope: '/', via: 'group' });
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      unreadable: `${whose} directory roles held through groups could not be read (${err.status} ${err.code})`,
    };
  }
  const names = new Map<string, string | undefined>();
  for (const g of grants) {
    if (g.name) continue;
    const id = g.roleDefinitionId.toLowerCase();
    if (!names.has(id))
      names.set(
        id,
        await graph
          .request<{ displayName?: string }>({
            path: `/roleManagement/directory/roleDefinitions/${encodeURIComponent(id)}`,
            query: { $select: 'displayName' },
          })
          .then((r) => r.data.displayName)
          .catch(() => undefined),
      );
    g.name = names.get(id);
  }
  return grants;
}

const AUTH_METHODS_POLICY = '/policies/authenticationMethodsPolicy';
type Json = Record<string, unknown>;
/** Drops OData annotations (`@odata.*`) from an object read from Graph before it is sent back. */
const withoutAnnotations = (o: Json): Json =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('@')));

/** The registration campaign object exactly as Graph returns it, or undefined when the policy has none. */
async function readCampaignJson(graph: GraphClient): Promise<Json | undefined> {
  const { data } = await graph.request<{
    registrationEnforcement?: { authenticationMethodsRegistrationCampaign?: Json | null } | null;
  }>({ path: AUTH_METHODS_POLICY });
  const campaign = data.registrationEnforcement?.authenticationMethodsRegistrationCampaign;
  return campaign && typeof campaign === 'object' ? campaign : undefined;
}

const targetsOf = (campaign: Json, key: 'excludeTargets' | 'includeTargets'): Json[] =>
  Array.isArray(campaign[key])
    ? (campaign[key] as unknown[]).filter((t): t is Json => !!t && typeof t === 'object')
    : [];

/**
 * Entra's authentication-methods registration campaign (who it targets and excludes). Read-only. A policy the
 * provisioner may not read is reported as a reason, not an error: the rest of the test identities still converge.
 */
export async function readRegistrationCampaign(
  graph: GraphClient,
): Promise<RegistrationCampaign | { unreadable: string }> {
  try {
    const campaign = await readCampaignJson(graph);
    if (!campaign) return { unreadable: 'the authentication methods policy has no registration campaign' };
    return {
      ...(typeof campaign.state === 'string' ? { state: campaign.state } : {}),
      excludeTargets: targetsOf(campaign, 'excludeTargets')
        .filter((t) => typeof t.id === 'string')
        .map((t) => ({
          id: t.id as string,
          ...(typeof t.targetType === 'string' ? { targetType: t.targetType } : {}),
        })),
    };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      unreadable:
        err.status === 401 || err.status === 403
          ? 'the provisioner may not read the authentication methods policy — give it Global Administrator while provisioning, or exclude the validation user from the registration campaign in the Entra admin centre (Authentication methods → Registration campaign)'
          : `the authentication methods policy could not be read (${err.status} ${err.code})`,
    };
  }
}

/**
 * Adds one user to the registration campaign's `excludeTargets`. Graph replaces the campaign as a whole, so the
 * campaign is re-read and sent back exactly as it is (state, includeTargets, snooze, other exclusions) plus this
 * one user. Idempotent.
 */
export async function excludeFromRegistrationCampaign(
  graph: GraphClient,
  userId: string,
): Promise<'added' | 'unchanged'> {
  const campaign = await readCampaignJson(graph);
  // A plain Error: nothing to wait for (an ApiError 404 would be retried as replication delay).
  if (!campaign) throw new Error('The authentication methods policy has no registration campaign.');
  const excludes = targetsOf(campaign, 'excludeTargets');
  if (excludes.some((t) => String(t.id).toLowerCase() === userId.toLowerCase())) return 'unchanged';
  await graph.request({
    method: 'PATCH',
    path: AUTH_METHODS_POLICY,
    body: {
      registrationEnforcement: {
        authenticationMethodsRegistrationCampaign: {
          ...withoutAnnotations(campaign),
          includeTargets: targetsOf(campaign, 'includeTargets').map(withoutAnnotations),
          excludeTargets: [...excludes.map(withoutAnnotations), { id: userId, targetType: 'user' }],
        },
      },
    },
  });
  return 'added';
}

/**
 * Takes one user out of the registration campaign's `excludeTargets` (the approver fixture, before it is deleted).
 * Like `excludeFromRegistrationCampaign`, the campaign is sent back exactly as it is, minus this one user. Idempotent.
 */
export async function removeFromRegistrationCampaignExclusions(
  graph: GraphClient,
  userId: string,
): Promise<'removed' | 'unchanged'> {
  const campaign = await readCampaignJson(graph);
  if (!campaign) return 'unchanged';
  const excludes = targetsOf(campaign, 'excludeTargets');
  const rest = excludes.filter((t) => String(t.id).toLowerCase() !== userId.toLowerCase());
  if (rest.length === excludes.length) return 'unchanged';
  await graph.request({
    method: 'PATCH',
    path: AUTH_METHODS_POLICY,
    body: {
      registrationEnforcement: {
        authenticationMethodsRegistrationCampaign: {
          ...withoutAnnotations(campaign),
          includeTargets: targetsOf(campaign, 'includeTargets').map(withoutAnnotations),
          excludeTargets: rest.map(withoutAnnotations),
        },
      },
    },
  });
  return 'removed';
}

/**
 * `provision test-identities --enable | --disable`: the validation user holds standing directory roles, so it stays
 * disabled except while the live suite runs (the approver fixture likewise, with `isProvisionedApprover` as `owns`).
 * Disabling also revokes its sign-in sessions. Idempotent.
 */
export async function setUserEnabled(
  graph: GraphClient,
  upn: string,
  enabled: boolean,
  owns: (user: GraphUser) => boolean = isProvisionedTester,
): Promise<'changed' | 'unchanged' | 'missing' | 'refused'> {
  const user = await findUser(graph, upn);
  if (!user) return 'missing';
  // Only the account provisioning created: never someone's account behind a mistyped UPN key.
  if (!owns(user)) return 'refused';
  if ((user.accountEnabled ?? true) === enabled) return 'unchanged';
  await graph.request({ method: 'PATCH', path: `/users/${user.id}`, body: { accountEnabled: enabled } });
  if (!enabled)
    await graph
      .request({ method: 'POST', path: `/users/${user.id}/revokeSignInSessions` })
      .catch(() => undefined); // best effort: a disabled account can't refresh its tokens anyway
  return 'changed';
}

/** Security Defaults state: true/false, or "unknown" when no identity available may read it. */
export async function readSecurityDefaults(graphs: GraphClient[]): Promise<boolean | 'unknown'> {
  for (const graph of graphs) {
    try {
      const { data } = await graph.request<{ isEnabled?: boolean }>({
        path: '/policies/identitySecurityDefaultsEnforcementPolicy',
      });
      if (typeof data.isEnabled === 'boolean') return data.isEnabled;
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 401)) throw err;
    }
  }
  return 'unknown';
}

export interface IdentityApplyContext {
  graph: GraphClient;
  writeEnv: (updates: Record<string, string>) => void;
  log: (line: string) => void;
  retry?: RetryOptions;
  password?: () => string;
}

const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 409 ||
    /already exist|conflicting object|same value for property/i.test(`${err.code} ${err.message}`));

/** Executes the non-noop operations in order. The tester's password goes to the env file only. */
export async function applyIdentityOps(
  ops: IdentityOp[],
  state: IdentityState,
  ctx: IdentityApplyContext,
): Promise<void> {
  const { graph, log } = ctx;
  const password = ctx.password ?? (() => generatePassword());
  const retry = <T>(fn: () => Promise<T>) =>
    withReplicationRetry(fn, {
      ...ctx.retry,
      onRetry: (_e, n, ms) =>
        log(`      … waiting ${Math.round(ms / 1000)}s for directory replication (attempt ${n})`),
    });
  let testerId = state.tester?.id;
  const testGroupId = state.testGroup?.id;
  const groupId = (role: keyof IdentityState['portalGroups']) => state.portalGroups[role]?.id;

  const createUser = async (
    spec: { upn: string; displayName: string; mailNickname: string },
    pwd: string,
    neverExpire: boolean,
    enabled = true,
    extra: Record<string, string> = {},
  ) =>
    (
      await graph.request<GraphUser>({
        method: 'POST',
        path: '/users',
        body: {
          accountEnabled: enabled,
          displayName: spec.displayName,
          mailNickname: spec.mailNickname,
          userPrincipalName: spec.upn,
          passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false },
          ...(neverExpire ? { passwordPolicies: 'DisablePasswordExpiration' } : {}),
          ...extra,
        },
      })
    ).data;
  /** Never set the password of (or otherwise change) an account provisioning didn't create. */
  const assertTester = (user: GraphUser) => {
    if (!isProvisionedTester(user))
      throw new Error(
        'Refusing to change the account at AF_TEST_USER_UPN: it was not created by AdminForge provisioning.',
      );
    return user;
  };

  for (const op of ops) {
    if (op.action === 'noop' || op.action === 'skip') continue;
    switch (op.kind) {
      case 'tester': {
        if (op.refused) throw new Error(`Refusing to provision the validation user: ${op.refused}`);
        const pwd = password();
        let created = false;
        if (op.mode === 'create') {
          try {
            // Created disabled: the live suite enables it for the run (`--enable`) and disables it afterwards. The
            // marker tells later runs that this account is provisioning's own.
            testerId = (await createUser(op.user, pwd, true, false, { employeeType: TESTER_MARKER })).id;
            created = true;
            log(`  ✓ created user: ${op.title}`);
          } catch (err) {
            // Exists already (a stale read missed it): fall through to setting its password — only if it is ours.
            if (!isAlreadyExists(err)) throw err;
            testerId = assertTester(
              await retry(
                async () =>
                  (await findUser(graph, op.user.upn)) ?? Promise.reject(notYetVisible(op.user.upn)),
              ),
            ).id;
          }
        } else if (!state.tester || assertTester(state.tester).id !== testerId)
          throw new Error('The validation user changed while provisioning; run it again.');
        if (!created) {
          const id = testerId!;
          await retry(() =>
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
        ctx.writeEnv({ AF_TEST_USER_UPN: op.user.upn, AF_TEST_USER_PASSWORD: pwd });
        log('  ✓ wrote AF_TEST_USER_UPN and AF_TEST_USER_PASSWORD to the env file (password not shown)');
        break;
      }
      case 'membership': {
        const gid = groupId(op.role)!;
        const uid = testerId!;
        try {
          await retry(() =>
            graph.request({
              method: 'POST',
              path: `/groups/${gid}/members/$ref`,
              body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${uid}` },
            }),
          );
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        log(`  ✓ added: ${op.title}`);
        break;
      }
      case 'membershipRemove': {
        const gid = groupId(op.role)!;
        const uid = testerId!;
        try {
          await retry(() => graph.request({ method: 'DELETE', path: `/groups/${gid}/members/${uid}/$ref` }));
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        log(`  ✓ removed: ${op.title}`);
        break;
      }
      case 'directoryRoleRemove': {
        for (const id of op.assignmentIds)
          try {
            await retry(() =>
              graph.request({ method: 'DELETE', path: `/roleManagement/directory/roleAssignments/${id}` }),
            );
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) throw err;
          }
        log(`  ✓ removed: ${op.title}`);
        break;
      }
      case 'testGroupOwner': {
        const uid = testerId!;
        const group = await retry(
          async () =>
            testGroupId ??
            (await findGroup(graph, op.uniqueName))?.id ??
            Promise.reject(notYetVisible(op.uniqueName)),
        );
        try {
          await retry(() =>
            graph.request({
              method: 'POST',
              path: `/groups/${group}/owners/$ref`,
              body: { '@odata.id': `https://graph.microsoft.com/v1.0/users/${uid}` },
            }),
          );
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        log(`  ✓ added owner: ${op.title}`);
        break;
      }
      case 'directoryRole': {
        const uid = testerId!;
        try {
          await retry(() =>
            graph.request({
              method: 'POST',
              path: '/roleManagement/directory/roleAssignments',
              body: { principalId: uid, roleDefinitionId: op.roleDefinitionId, directoryScopeId: '/' },
            }),
          );
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        log(`  ✓ assigned: ${op.title}`);
        break;
      }
      case 'target': {
        // Write-test targets get a random password that is deliberately not stored anywhere.
        try {
          await createUser(op.user, password(), false);
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        log(`  ✓ created user: ${op.title}`);
        break;
      }
      case 'testGroup': {
        await retry(async () => {
          try {
            await graph.request<GraphGroup>({
              method: 'PATCH',
              path: `/groups(uniqueName=${odata(op.uniqueName)})`,
              body: op.body,
              headers: { Prefer: 'create-if-missing' },
            });
          } catch (err) {
            if (isAlreadyExists(err)) return;
            if (
              !(err instanceof ApiError) ||
              ![400, 405, 501].includes(err.status) ||
              !/segment|not supported|alternate key|Prefer/i.test(err.message)
            )
              throw err;
            await graph.request({
              method: 'POST',
              path: '/groups',
              body: { ...op.body, uniqueName: op.uniqueName },
            });
          }
        });
        log(`  ✓ created group: ${op.title}`);
        break;
      }
      case 'campaignExclusion': {
        const uid = testerId!;
        const result = await retry(() => excludeFromRegistrationCampaign(graph, uid));
        log(`  ✓ ${result === 'added' ? 'excluded' : 'already excluded'}: ${op.title}`);
        break;
      }
      case 'skipped':
        break;
    }
  }
}
