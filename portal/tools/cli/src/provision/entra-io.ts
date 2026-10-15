import { ApiError, type GraphClient, type HttpClient } from '@adminforge/connectors';
import { RESOURCE_KEYS, RESOURCES, type PortalRole } from './catalog';
import { armRoleAssignmentName } from './ids';
import type {
  AppKey,
  AppRoleAssignment,
  ArmRoleAssignment,
  DesiredEntra,
  EntraOp,
  EntraState,
  GraphApplication,
  GraphGroup,
  GraphServicePrincipal,
  PermissionGrant,
  ResourceServicePrincipal,
} from './model';
import { withReplicationRetry, type RetryOptions } from './retry';

export const ARM_BASE = 'https://management.azure.com';
const ARM_API = '2022-04-01';

const APP_SELECT = 'id,appId,displayName,uniqueName,signInAudience,groupMembershipClaims,web,appRoles,optionalClaims,requiredResourceAccess,passwordCredentials';
const SP_SELECT = 'id,appId,displayName,appRoleAssignmentRequired,tags';
const GROUP_SELECT = 'id,displayName,uniqueName,description,securityEnabled,mailEnabled';

/** OData string literal. */
export const odata = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function findOne<T>(graph: GraphClient, path: string, filter: string, select: string): Promise<T | undefined> {
  const { data } = await graph.request<{ value: T[] }>({ path, query: { $filter: filter, $select: select } });
  return data.value[0];
}

/** Looks an object up by alternate key (uniqueName); falls back to GET /collection(uniqueName='…') if $filter is refused. */
async function findByUniqueName<T>(graph: GraphClient, collection: string, uniqueName: string, select: string): Promise<T | undefined> {
  try {
    return await findOne<T>(graph, collection, `uniqueName eq ${odata(uniqueName)}`, select);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 400) throw err;
    try {
      return (await graph.request<T>({ path: `${collection}(uniqueName=${odata(uniqueName)})`, query: { $select: select } })).data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    }
  }
}

export const findApplication = (graph: GraphClient, uniqueName: string) => findByUniqueName<GraphApplication>(graph, '/applications', uniqueName, APP_SELECT);
export const findGroup = (graph: GraphClient, uniqueName: string) => findByUniqueName<GraphGroup>(graph, '/groups', uniqueName, GROUP_SELECT);
export const findServicePrincipal = (graph: GraphClient, appId: string) =>
  findOne<GraphServicePrincipal>(graph, '/servicePrincipals', `appId eq ${odata(appId)}`, SP_SELECT);

/** Resource service principals (Graph, ARM, Log Analytics, Exchange) with their published permissions. */
export async function fetchResources(graph: GraphClient): Promise<EntraState['resources']> {
  const out: EntraState['resources'] = {};
  for (const key of RESOURCE_KEYS) {
    const sp = await findOne<ResourceServicePrincipal>(
      graph,
      '/servicePrincipals',
      `appId eq ${odata(RESOURCES[key].appId)}`,
      'id,appId,displayName,oauth2PermissionScopes,appRoles',
    );
    if (sp) out[key] = sp;
  }
  return out;
}

export async function listArmAssignments(arm: HttpClient, scope: string, principalId: string): Promise<ArmRoleAssignment[]> {
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const { data } = await arm.send<{ value: ArmRoleAssignment[] }>({
    url: `${ARM_BASE}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=${ARM_API}&$filter=${filter}`,
  });
  return data.value;
}

/** Reads everything the Entra plan compares against. Read-only. */
export async function fetchEntraState(
  graph: GraphClient,
  arm: HttpClient | undefined,
  desired: DesiredEntra,
  resources: EntraState['resources'],
  env: EntraState['env'],
): Promise<EntraState> {
  const state: EntraState = { resources, apps: {}, sps: {}, grants: {}, assignedTo: {}, appPermissions: {}, groups: {}, arm: { assignments: [] }, env };
  for (const app of desired.apps) {
    const current = await findApplication(graph, app.uniqueName);
    if (!current) continue;
    state.apps[app.key] = current;
    const sp = await findServicePrincipal(graph, current.appId);
    if (!sp) continue;
    state.sps[app.key] = sp;
    state.grants[app.key] = await graph.all<PermissionGrant>({ path: '/oauth2PermissionGrants', query: { $filter: `clientId eq ${odata(sp.id)}` } });
    state.assignedTo[app.key] = await graph.all<AppRoleAssignment>({ path: `/servicePrincipals/${sp.id}/appRoleAssignedTo` });
    state.appPermissions[app.key] = await graph.all<AppRoleAssignment>({ path: `/servicePrincipals/${sp.id}/appRoleAssignments` });
  }
  for (const g of desired.groups) {
    const current = await findGroup(graph, g.uniqueName);
    if (current) state.groups[g.role] = current;
  }
  const automation = state.sps.automation;
  if (desired.arm && automation) {
    if (!arm) state.arm.error = 'no ARM client';
    else
      try {
        state.arm.assignments = await listArmAssignments(arm, desired.arm.scope, automation.id);
      } catch (err) {
        state.arm.error = err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err);
      }
  }
  return state;
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyContext {
  graph: GraphClient;
  arm?: HttpClient;
  /** Writes keys to the local env file (never echoes values). */
  writeEnv: (updates: Record<string, string>) => void;
  log: (line: string) => void;
  retry?: RetryOptions;
  now?: () => Date;
}

/** Ids known so far: from fetched state, then from objects created during apply. */
export interface Refs {
  app: Partial<Record<AppKey, { id: string; appId: string }>>;
  sp: Partial<Record<AppKey, string>>;
  group: Partial<Record<PortalRole, string>>;
  resource: Partial<Record<string, string>>;
}

export function refsFrom(state: EntraState): Refs {
  const refs: Refs = { app: {}, sp: {}, group: {}, resource: {} };
  for (const [k, a] of Object.entries(state.apps)) if (a) refs.app[k as AppKey] = { id: a.id, appId: a.appId };
  for (const [k, s] of Object.entries(state.sps)) if (s) refs.sp[k as AppKey] = s.id;
  for (const [k, g] of Object.entries(state.groups)) if (g) refs.group[k as PortalRole] = g.id;
  for (const [k, r] of Object.entries(state.resources)) if (r) refs.resource[k] = r.id;
  return refs;
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`Internal: ${what} is not known yet (an earlier step did not run).`);
  return value;
};

/** Upsert errors that mean "this alternate-key form is not supported here" → use query-then-create instead. */
const upsertUnsupported = (err: unknown) =>
  err instanceof ApiError && [400, 405, 501].includes(err.status) && /segment|not supported|alternate key|create-if-missing|Prefer/i.test(err.message);

const isUniqueConflict = (err: unknown) =>
  err instanceof ApiError && (err.status === 400 || err.status === 409) && /same value for property|already exists/i.test(err.message);

/** Thrown when an object that must exist is not yet visible on the replica we hit; retried by withReplicationRetry. */
const notYetVisible = (what: string) => new ApiError(404, 'Request_ResourceNotFound', `${what} is not visible yet (directory replication)`);

/**
 * Graph upsert: PATCH /collection(key='…') with Prefer: create-if-missing.
 * 201 → created (body returned); 204 → it already existed and was updated (re-read with `reread`).
 * A uniqueness conflict means it exists but this replica's alternate-key lookup missed it: re-read and PATCH by id.
 */
async function upsert<T extends { id: string }>(
  graph: GraphClient,
  collection: string,
  keyPath: string,
  body: unknown,
  create: () => Promise<T>,
  reread: () => Promise<T | undefined>,
): Promise<T> {
  try {
    const r = await graph.request<T>({ method: 'PATCH', path: keyPath, body, headers: { Prefer: 'create-if-missing' } });
    if (r.status === 201 && r.data) return r.data;
  } catch (err) {
    if (upsertUnsupported(err)) return create();
    if (!isUniqueConflict(err)) throw err;
    const existing = await reread();
    if (!existing) throw notYetVisible(keyPath);
    await graph.request({ method: 'PATCH', path: `${collection}/${existing.id}`, body });
    return existing;
  }
  const existing = await reread();
  if (!existing) throw notYetVisible(keyPath);
  return existing;
}

const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError && (err.status === 409 || /already exist|conflicting object|RoleAssignmentExists/i.test(`${err.code} ${err.message}`));

const VERB: Record<string, string> = { create: 'created', update: 'updated' };
const NOUN: Partial<Record<EntraOp['kind'], string>> = {
  application: 'application',
  servicePrincipal: 'service principal',
  group: 'group',
  grant: 'consent grant',
  appRoleAssignment: 'app role assignment',
  armRoleAssignment: 'Azure role assignment',
};

/** Executes the non-noop operations in order. Secrets go straight to the env file and are never printed. */
export async function applyEntraOps(ops: EntraOp[], state: EntraState, ctx: ApplyContext): Promise<Refs> {
  const { graph, log } = ctx;
  const refs = refsFrom(state);
  const now = ctx.now ?? (() => new Date());
  const retry = <T>(fn: () => Promise<T>) =>
    withReplicationRetry(fn, { ...ctx.retry, onRetry: (_e, n, ms) => log(`      … waiting ${Math.round(ms / 1000)}s for directory replication (attempt ${n})`) });

  for (const op of ops) {
    if (op.action === 'noop' || op.action === 'skip') continue;
    switch (op.kind) {
      case 'application': {
        if (op.action === 'create') {
          const created = await retry(() =>
            upsert<GraphApplication>(
              graph,
              '/applications',
              `/applications(uniqueName=${odata(op.uniqueName)})`,
              op.body,
              async () => (await graph.request<GraphApplication>({ method: 'POST', path: '/applications', body: { ...op.body, uniqueName: op.uniqueName } })).data,
              () => findApplication(graph, op.uniqueName),
            ),
          );
          refs.app[op.app] = { id: created.id, appId: created.appId };
        } else {
          const id = need(refs.app[op.app], `${op.app} application`).id;
          await retry(() => graph.request({ method: 'PATCH', path: `/applications/${id}`, body: op.body }));
        }
        break;
      }
      case 'servicePrincipal': {
        const appId = need(refs.app[op.app], `${op.app} application`).appId;
        if (op.action === 'create') {
          const sp = await retry(() =>
            upsert<GraphServicePrincipal>(
              graph,
              '/servicePrincipals',
              `/servicePrincipals(appId=${odata(appId)})`,
              op.body,
              async () => (await graph.request<GraphServicePrincipal>({ method: 'POST', path: '/servicePrincipals', body: { appId, ...op.body } })).data,
              () => findServicePrincipal(graph, appId),
            ),
          );
          refs.sp[op.app] = sp.id;
        } else {
          const id = need(refs.sp[op.app], `${op.app} service principal`);
          const tags = [...new Set([...(state.sps[op.app]?.tags ?? []), ...op.body.tags])];
          await retry(() => graph.request({ method: 'PATCH', path: `/servicePrincipals/${id}`, body: { ...op.body, tags } }));
        }
        break;
      }
      case 'envClientId': {
        ctx.writeEnv({ [op.envKey]: need(refs.app[op.app], `${op.app} application`).appId });
        log(`  ✓ wrote ${op.envKey} to the env file`);
        continue;
      }
      case 'secret': {
        const id = need(refs.app[op.app], `${op.app} application`).id;
        const endDateTime = new Date(now().getTime() + op.days * 86_400_000).toISOString();
        const { data } = await retry(() =>
          graph.request<{ secretText?: string }>({ method: 'POST', path: `/applications/${id}/addPassword`, body: { passwordCredential: { displayName: op.displayName, endDateTime } } }),
        );
        if (!data.secretText) throw new Error(`addPassword for ${op.envKey} returned no secret`);
        ctx.writeEnv({ [op.envKey]: data.secretText });
        log(`  ✓ created client secret "${op.displayName}" (${op.days} days) → ${op.envKey} written to the env file (value not shown)`);
        continue;
      }
      case 'group': {
        if (op.action === 'create') {
          const g = await retry(() =>
            upsert<GraphGroup>(
              graph,
              '/groups',
              `/groups(uniqueName=${odata(op.uniqueName)})`,
              op.body,
              async () => (await graph.request<GraphGroup>({ method: 'POST', path: '/groups', body: { ...op.body, uniqueName: op.uniqueName } })).data,
              () => findGroup(graph, op.uniqueName),
            ),
          );
          refs.group[op.role] = g.id;
        } else {
          const id = need(refs.group[op.role], `group ${op.role}`);
          await retry(() => graph.request({ method: 'PATCH', path: `/groups/${id}`, body: { displayName: op.body.displayName, description: op.body.description } }));
        }
        break;
      }
      case 'grant': {
        if (op.action === 'create') {
          const clientId = need(refs.sp[op.app], `${op.app} service principal`);
          const resourceId = need(refs.resource[op.resource], `${op.resource} resource service principal`);
          await retry(() => graph.request({ method: 'POST', path: '/oauth2PermissionGrants', body: { clientId, consentType: 'AllPrincipals', resourceId, scope: op.scope } }));
        } else {
          await retry(() => graph.request({ method: 'PATCH', path: `/oauth2PermissionGrants/${need(op.grantId, 'grant id')}`, body: { scope: op.scope } }));
        }
        break;
      }
      case 'appRoleAssignment': {
        const principalId = 'group' in op.principal ? need(refs.group[op.principal.group], `group ${op.principal.group}`) : need(refs.sp[op.principal.app], `${op.principal.app} service principal`);
        const resourceId = 'app' in op.target ? need(refs.sp[op.target.app], `${op.target.app} service principal`) : need(refs.resource[op.target.resource], `${op.target.resource} resource`);
        try {
          await retry(() => graph.request({ method: 'POST', path: `/servicePrincipals/${resourceId}/appRoleAssignedTo`, body: { principalId, resourceId, appRoleId: op.appRoleId } }));
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        break;
      }
      case 'armRoleAssignment': {
        const arm = need(ctx.arm, 'ARM client');
        const principalId = need(refs.sp.automation, 'automation service principal');
        const name = armRoleAssignmentName(op.scope, op.roleDefinitionId, principalId);
        try {
          await withReplicationRetry(
            () =>
              arm.send({
                method: 'PUT',
                url: `${ARM_BASE}${op.scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=${ARM_API}`,
                body: { properties: { roleDefinitionId: op.roleDefinitionId, principalId, principalType: 'ServicePrincipal' } },
              }),
            {
              attempts: 10,
              ...ctx.retry,
              isRetryable: (e) => e instanceof ApiError && (e.code === 'PrincipalNotFound' || /does not exist in the directory/i.test(e.message)),
              onRetry: (_e, n, ms) => log(`      … waiting ${Math.round(ms / 1000)}s for the principal to reach Azure RBAC (attempt ${n})`),
            },
          );
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
        break;
      }
      case 'skipped':
        continue;
    }
    log(`  ✓ ${VERB[op.action]} ${NOUN[op.kind] ?? op.kind}: ${op.title}`);
  }
  return refs;
}
