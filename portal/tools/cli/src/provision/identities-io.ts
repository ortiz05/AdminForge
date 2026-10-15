import { ApiError, type GraphClient } from '@adminforge/connectors';
import { findGroup, odata } from './entra-io';
import { groupNames } from './entra-desired';
import { PORTAL_ROLES } from './catalog';
import type { DesiredIdentities, GraphUser, IdentityOp, IdentityState } from './identities-plan';
import type { GraphGroup } from './model';
import { generatePassword } from './password';
import { withReplicationRetry, type RetryOptions } from './retry';

const USER_SELECT = 'id,userPrincipalName,displayName,accountEnabled';
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
  if (state.tester) {
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
  return state;
}

/**
 * `provision test-identities --enable | --disable`: the validation user holds standing directory roles, so it stays
 * disabled except while the live suite runs. Disabling also revokes its sign-in sessions. Idempotent.
 */
export async function setUserEnabled(
  graph: GraphClient,
  upn: string,
  enabled: boolean,
): Promise<'changed' | 'unchanged' | 'missing'> {
  const user = await findUser(graph, upn);
  if (!user) return 'missing';
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
        },
      })
    ).data;

  for (const op of ops) {
    if (op.action === 'noop' || op.action === 'skip') continue;
    switch (op.kind) {
      case 'tester': {
        const pwd = password();
        let created = false;
        if (op.mode === 'create') {
          try {
            // Created disabled: the live suite enables it for the run (`--enable`) and disables it afterwards.
            testerId = (await createUser(op.user, pwd, true, false)).id;
            created = true;
            log(`  ✓ created user: ${op.title}`);
          } catch (err) {
            // Exists already (a stale read missed it): fall through to setting its password.
            if (!isAlreadyExists(err)) throw err;
            testerId = (
              await retry(
                async () =>
                  (await findUser(graph, op.user.upn)) ?? Promise.reject(notYetVisible(op.user.upn)),
              )
            ).id;
          }
        }
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
      case 'skipped':
        break;
    }
  }
}
