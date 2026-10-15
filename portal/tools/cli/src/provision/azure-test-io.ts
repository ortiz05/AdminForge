import {
  ApiError,
  defaultSleep,
  type GraphClient,
  type HttpClient,
  type Sleep,
} from '@adminforge/connectors';
import { ARM_BASE, findServicePrincipal, listArmAssignments } from './entra-io';
import { findUser } from './identities-io';
import { armRoleAssignmentName } from './ids';
import {
  ENV_LOCATION,
  ENV_WORKSPACE_ID,
  roleDefinitionId,
  type ArmDiagnosticSetting,
  type ArmResourceGroup,
  type ArmWorkspace,
  type AzureTestOp,
  type AzureTestState,
  type DesiredAzureTest,
  type PrincipalKey,
} from './azure-test-plan';
import { withReplicationRetry, type RetryOptions } from './retry';

/** Thin ARM / Graph I/O for `provision azure-test`. Everything decided lives in azure-test-plan.ts. */

export const API = {
  resourceGroups: '2021-04-01',
  workspaces: '2023-09-01',
  diagnosticSettings: '2021-05-01-preview',
  roleAssignments: '2022-04-01',
} as const;

const url = (path: string, apiVersion: string, extra = '') =>
  `${ARM_BASE}${path}?api-version=${apiVersion}${extra}`;
const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

async function getOrUndefined<T>(arm: HttpClient, u: string): Promise<T | undefined> {
  try {
    return (await arm.send<T>({ url: u })).data;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export interface PrincipalInputs {
  automationClientId?: string;
  testerUpn?: string;
}

/** Object ids of the automation service principal and the validation user (provisioner identity, Graph). */
export async function resolvePrincipals(
  graph: GraphClient,
  inputs: PrincipalInputs,
  labels: { automation: string },
) {
  const principals: AzureTestState['principals'] = {};
  const missing: AzureTestState['missing'] = {};
  if (!inputs.automationClientId)
    missing.automation = 'AF_AUTOMATION_CLIENT_ID is not set — run `pnpm adminforge provision entra` first';
  else {
    const sp = await findServicePrincipal(graph, inputs.automationClientId);
    if (sp) principals.automation = sp.id;
    else
      missing.automation = `${labels.automation} has no service principal — run \`pnpm adminforge provision entra\``;
  }
  if (!inputs.testerUpn)
    missing.tester = 'AF_TEST_USER_UPN is not set — run `pnpm adminforge provision test-identities` first';
  else {
    const user = await findUser(graph, inputs.testerUpn);
    if (user) principals.tester = user.id;
    else
      missing.tester =
        'the validation user (AF_TEST_USER_UPN) does not exist — run `pnpm adminforge provision test-identities`';
  }
  return { principals, missing };
}

/** Reads everything the plan compares against. Read-only. */
export async function fetchAzureTestState(
  arm: HttpClient,
  graph: GraphClient,
  desired: DesiredAzureTest,
  inputs: PrincipalInputs & { env: AzureTestState['env'] },
): Promise<AzureTestState> {
  const resourceGroup = await getOrUndefined<ArmResourceGroup>(
    arm,
    url(desired.resourceGroup.id, API.resourceGroups),
  );
  const workspace = resourceGroup
    ? await getOrUndefined<ArmWorkspace>(arm, url(desired.workspace.id, API.workspaces))
    : undefined;
  const diagnostic = await getOrUndefined<ArmDiagnosticSetting>(
    arm,
    url(desired.diagnostic.id, API.diagnosticSettings),
  );
  const { principals, missing } = await resolvePrincipals(graph, inputs, {
    automation: desired.roles[0]!.principalLabel,
  });
  const assignments: AzureTestState['assignments'] = {};
  const scopes = new Set(desired.roles.map((r) => r.scope));
  for (const scope of scopes) {
    // The workspace scope can only hold assignments once the workspace exists.
    if (scope === desired.workspace.id && !workspace) continue;
    const list: AzureTestState['assignments'][string] = [];
    for (const key of ['automation', 'tester'] as PrincipalKey[]) {
      const id = principals[key];
      if (id && desired.roles.some((r) => r.principal === key && r.scope === scope))
        list.push(...(await listArmAssignments(arm, scope, id)));
    }
    assignments[scope.toLowerCase()] = list;
  }
  return { resourceGroup, workspace, diagnostic, principals, missing, assignments, env: inputs.env };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface AzureApplyContext {
  arm: HttpClient;
  writeEnv: (updates: Record<string, string>) => void;
  log: (line: string) => void;
  retry?: RetryOptions;
  sleep?: Sleep;
  /** Polls while the workspace provisions (default 40 × 3 s). */
  poll?: { attempts?: number; intervalMs?: number };
}

const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 409 || /RoleAssignmentExists|already exists/i.test(`${err.code} ${err.message}`));

/** PUT the workspace, then wait until it has finished provisioning; returns it (with its customerId). */
async function putWorkspace(desired: DesiredAzureTest, ctx: AzureApplyContext): Promise<ArmWorkspace> {
  const sleep = ctx.sleep ?? defaultSleep;
  const attempts = ctx.poll?.attempts ?? 40;
  const interval = ctx.poll?.intervalMs ?? 3000;
  let ws = (
    await ctx.arm.send<ArmWorkspace>({
      method: 'PUT',
      url: url(desired.workspace.id, API.workspaces),
      body: desired.workspace.body,
    })
  ).data;
  for (let i = 0; i < attempts && ws?.properties?.provisioningState !== 'Succeeded'; i++) {
    if (ws?.properties?.provisioningState === 'Failed')
      throw new Error(`Workspace ${desired.workspace.name} failed to provision.`);
    await sleep(interval);
    ws = (await ctx.arm.send<ArmWorkspace>({ url: url(desired.workspace.id, API.workspaces) })).data;
  }
  if (ws?.properties?.provisioningState !== 'Succeeded')
    throw new Error(
      `Workspace ${desired.workspace.name} is still provisioning; run the command again in a minute.`,
    );
  return ws;
}

/** Executes the non-noop operations in order. Prints names only; ids go to the env file. */
export async function applyAzureTestOps(
  ops: AzureTestOp[],
  desired: DesiredAzureTest,
  state: AzureTestState,
  ctx: AzureApplyContext,
): Promise<void> {
  const { arm, log } = ctx;
  let customerId = state.workspace?.properties?.customerId;
  for (const op of ops) {
    if (op.action === 'noop' || op.action === 'skip') continue;
    switch (op.kind) {
      case 'resourceGroup':
        await arm.send({
          method: 'PUT',
          url: url(desired.resourceGroup.id, API.resourceGroups),
          body: { location: desired.resourceGroup.location, tags: desired.resourceGroup.tags },
        });
        log(`  ✓ created ${op.title}`);
        break;
      case 'workspace': {
        const ws = await putWorkspace(desired, ctx);
        customerId = ws.properties?.customerId ?? customerId;
        log(`  ✓ ${op.action === 'create' ? 'created' : 'updated'} ${op.title}`);
        break;
      }
      case 'diagnosticSetting':
        await arm.send({
          method: 'PUT',
          url: url(desired.diagnostic.id, API.diagnosticSettings),
          body: {
            properties: {
              workspaceId: desired.workspace.id,
              logs: desired.diagnostic.categories.map((category) => ({ category, enabled: true })),
            },
          },
        });
        log(`  ✓ ${op.action === 'create' ? 'created' : 'updated'} ${op.title}`);
        break;
      case 'roleAssignment': {
        const principalId = state.principals[op.role.principal];
        if (!principalId) throw new Error(`Internal: ${op.role.principalLabel} was not resolved.`);
        const definition = roleDefinitionId(desired.subscriptionScope, op.role.roleGuid);
        const name = armRoleAssignmentName(op.role.scope, definition, principalId);
        try {
          await withReplicationRetry(
            () =>
              arm.send({
                method: 'PUT',
                url: url(
                  `${op.role.scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
                  API.roleAssignments,
                ),
                body: {
                  properties: {
                    roleDefinitionId: definition,
                    principalId,
                    principalType: op.role.principalType,
                  },
                },
              }),
            {
              attempts: 10,
              ...ctx.retry,
              isRetryable: (e) =>
                e instanceof ApiError &&
                (e.code === 'PrincipalNotFound' || /does not exist in the directory/i.test(e.message)),
              onRetry: (_e, n, ms) =>
                log(
                  `      … waiting ${Math.round(ms / 1000)}s for the principal to reach Azure RBAC (attempt ${n})`,
                ),
            },
          );
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        log(`  ✓ assigned ${op.title}`);
        break;
      }
      case 'env':
        if (op.key === ENV_WORKSPACE_ID) {
          if (!customerId)
            throw new Error(`Internal: the workspace id of ${desired.workspace.name} is not known.`);
          ctx.writeEnv({ [ENV_WORKSPACE_ID]: customerId });
        } else ctx.writeEnv({ [ENV_LOCATION]: desired.settings.location });
        log(`  ✓ wrote ${op.key} to the env file`);
        break;
      case 'skipped':
        break;
    }
  }
}

// ── Destroy ──────────────────────────────────────────────────────────────────

export interface DestroyResult {
  diagnostic: 'deleted' | 'absent';
  workspace: 'deleted' | 'absent';
  resourceGroup: 'deleted' | 'deleting' | 'absent';
  subscriptionRoles: number;
}

/**
 * Deletes the diagnostic setting, the workspace (force: no 14-day soft-delete, so the name is reusable at once),
 * the validation user's subscription-level Reader assignment that provisioning created, and the resource group.
 * Waits for the resource group deletion (bounded); role assignments inside the group go with it.
 */
export async function destroyAzureTest(
  arm: HttpClient,
  desired: DesiredAzureTest,
  principals: AzureTestState['principals'],
  ctx: { log: (line: string) => void; sleep?: Sleep; poll?: { attempts?: number; intervalMs?: number } },
): Promise<DestroyResult> {
  const sleep = ctx.sleep ?? defaultSleep;
  const del = async (u: string) => {
    try {
      return await arm.send({ method: 'DELETE', url: u });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  };
  const result: DestroyResult = {
    diagnostic: 'absent',
    workspace: 'absent',
    resourceGroup: 'absent',
    subscriptionRoles: 0,
  };

  // ARM answers DELETE with 200/202 when something was deleted and 204 (or 404) when there was nothing to delete.
  const deleted = (r: Awaited<ReturnType<typeof del>>) => !!r && r.status !== 204;
  const d = await del(url(desired.diagnostic.id, API.diagnosticSettings));
  result.diagnostic = deleted(d) ? 'deleted' : 'absent';
  ctx.log(
    `  ${result.diagnostic === 'deleted' ? '✓ deleted' : '= absent '} diagnostic setting ${desired.diagnostic.name}`,
  );

  for (const role of desired.roles.filter((r) => r.scope === desired.subscriptionScope)) {
    const principalId = principals[role.principal];
    if (!principalId) continue;
    const name = armRoleAssignmentName(
      role.scope,
      roleDefinitionId(desired.subscriptionScope, role.roleGuid),
      principalId,
    );
    const r = await del(
      url(`${role.scope}/providers/Microsoft.Authorization/roleAssignments/${name}`, API.roleAssignments),
    );
    if (deleted(r)) {
      result.subscriptionRoles++;
      ctx.log(`  ✓ removed ${role.principalLabel} → ${role.roleName} on ${role.scopeLabel}`);
    }
  }

  const rg = await getOrUndefined<ArmResourceGroup>(arm, url(desired.resourceGroup.id, API.resourceGroups));
  if (!rg) {
    ctx.log(`  = absent  resource group ${desired.resourceGroup.name}`);
    return result;
  }
  const w = await del(url(desired.workspace.id, API.workspaces, '&force=true'));
  if (deleted(w)) {
    result.workspace = 'deleted';
    ctx.log(`  ✓ deleted Log Analytics workspace ${desired.workspace.name} (not kept for recovery)`);
  }
  const res = await del(url(desired.resourceGroup.id, API.resourceGroups));
  if (!deleted(res)) return result;
  result.resourceGroup = 'deleting';
  const poll = res!.headers.get('location');
  const attempts = ctx.poll?.attempts ?? 60;
  const interval = ctx.poll?.intervalMs ?? 10_000;
  for (let i = 0; i < attempts; i++) {
    if (poll) {
      const r = await arm.send({ url: poll });
      if (r.status === 200 || r.status === 204) {
        result.resourceGroup = 'deleted';
        break;
      }
    } else if (!(await getOrUndefined(arm, url(desired.resourceGroup.id, API.resourceGroups)))) {
      result.resourceGroup = 'deleted';
      break;
    }
    if (i === 0) ctx.log(`      … waiting for Azure to delete resource group ${desired.resourceGroup.name}`);
    await sleep(interval);
  }
  ctx.log(
    result.resourceGroup === 'deleted'
      ? `  ✓ deleted resource group ${desired.resourceGroup.name}`
      : `  … resource group ${desired.resourceGroup.name} is still being deleted by Azure (it finishes on its own)`,
  );
  return result;
}
