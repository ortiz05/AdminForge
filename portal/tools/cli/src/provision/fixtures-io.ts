/**
 * Microsoft Graph I/O for the licensed test fixtures, as the provisioner identity (provision/fixtures-plan.ts
 * decides): reads the subscription, the test users' licences, PIM eligibility, named locations and the Intune
 * fixtures; applies a plan's operations (`applyFixtureOps`).
 *
 * Each fixture fails on its own: a part Graph refuses to read becomes an "unreadable" state with the permission the
 * provisioner needs (FIXTURE_PERMISSIONS), and an operation Graph refuses prints one `✗` line — the permission for a
 * 401/403, otherwise the status, code and a message with ids and addresses masked — and the other fixtures go on.
 * The caller decides the exit code from the failed fixtures returned. Nothing secret is printed.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { applyApproverOp, fetchApproverState } from './approver-io';
import { findGroup, odata } from './entra-io';
import {
  INTUNE_POLICIES,
  NAMED_LOCATION,
  isProvisionedAccount,
  permissionHint,
  wants,
  type ApproverState,
  type DesiredFixtures,
  type FixtureKey,
  type FixtureOp,
  type FixtureState,
  type FixtureUser,
  type GroupMember,
  type IntuneKind,
  type IntunePolicyState,
  type SkuInfo,
  type Unreadable,
} from './fixtures-model';
import { GUID_PATTERN } from './ids';
import { withReplicationRetry, type RetryOptions } from './retry';

const USER_SELECT =
  'id,userPrincipalName,displayName,accountEnabled,employeeType,usageLocation,assignedLicenses';

/** A refused or failed read, as the plan shows it. */
function unreadable(fixture: FixtureKey, err: ApiError): Unreadable {
  return err.status === 401 || err.status === 403
    ? { unreadable: permissionHint(fixture), forbidden: true }
    : { unreadable: `could not be read (${err.status} ${err.code})` };
}

async function readPart<T>(fixture: FixtureKey, fn: () => Promise<T>): Promise<T | Unreadable> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return unreadable(fixture, err);
  }
}

async function findFixtureUser(graph: GraphClient, upn: string): Promise<FixtureUser | undefined> {
  try {
    const { data } = await graph.request<FixtureUser & { assignedLicenses?: Array<{ skuId: string }> }>({
      path: `/users/${encodeURIComponent(upn)}`,
      query: { $select: USER_SELECT },
    });
    const { assignedLicenses, ...user } = data;
    return { ...user, skuIds: (assignedLicenses ?? []).map((l) => l.skuId.toLowerCase()) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

async function readSku(graph: GraphClient, partNumber: string): Promise<SkuInfo | null> {
  const { data } = await graph.request<{
    value?: Array<{
      skuId: string;
      skuPartNumber: string;
      capabilityStatus?: string;
      consumedUnits?: number;
      prepaidUnits?: { enabled?: number };
    }>;
  }>({
    path: '/subscribedSkus',
    query: { $select: 'skuId,skuPartNumber,capabilityStatus,consumedUnits,prepaidUnits' },
  });
  const sku = (data.value ?? []).find((s) => s.skuPartNumber === partNumber);
  return sku
    ? {
        skuId: sku.skuId.toLowerCase(),
        skuPartNumber: sku.skuPartNumber,
        capabilityStatus: sku.capabilityStatus ?? 'Unknown',
        consumedUnits: sku.consumedUnits ?? 0,
        enabledUnits: sku.prepaidUnits?.enabled ?? 0,
      }
    : null;
}

async function readIntune(graph: GraphClient): Promise<Record<IntuneKind, IntunePolicyState[]>> {
  const out = { compliance: [], configuration: [] } as Record<IntuneKind, IntunePolicyState[]>;
  for (const kind of ['compliance', 'configuration'] as IntuneKind[]) {
    const spec = INTUNE_POLICIES[kind];
    const all = await graph.all<{ id: string; displayName: string; description?: string | null }>({
      path: spec.path,
      query: { $select: 'id,displayName,description' },
    });
    for (const p of all.filter((x) => x.displayName === spec.displayName)) {
      const assignments = await graph.all<{ target?: { '@odata.type'?: string; groupId?: string } }>({
        path: `${spec.path}/${p.id}/assignments`,
      });
      // Each target keeps its type: an exclusion or "all devices" must not read as "assigned to the group".
      out[kind].push({
        ...p,
        targets: assignments.map((a) => ({
          type: a.target?.['@odata.type'] ?? 'unknown',
          ...(a.target?.groupId ? { groupId: a.target.groupId } : {}),
        })),
      });
    }
  }
  return out;
}

/** Reads everything the opted-in fixtures compare against. Read-only. */
export async function fetchFixtureState(
  graph: GraphClient,
  desired: DesiredFixtures,
  approverEnv: ApproverState['env'],
): Promise<FixtureState> {
  const s = desired.settings;
  const state: FixtureState = { users: {} };
  const people = [
    ...(wants(s, 'licences') ? desired.licensed : []),
    ...(wants(s, 'pim') ? desired.eligibility.map((e) => e.user) : []),
  ];
  for (const u of people)
    if (!(u.upn.toLowerCase() in state.users))
      state.users[u.upn.toLowerCase()] = await findFixtureUser(graph, u.upn);
  if (s.licenceSku) state.sku = await readPart('licences', () => readSku(graph, s.licenceSku!));
  if (wants(s, 'pim'))
    state.eligibility = await readPart('pim', async () => {
      const out: Record<string, Array<{ roleDefinitionId: string; directoryScopeId: string }>> = {};
      for (const e of desired.eligibility) {
        const key = e.user.upn.toLowerCase();
        const user = state.users[key];
        if (!user || key in out) continue;
        out[key] = await graph.all({
          path: '/roleManagement/directory/roleEligibilitySchedules',
          query: {
            $filter: `principalId eq ${odata(user.id)}`,
            $select: 'roleDefinitionId,directoryScopeId',
          },
        });
      }
      return out;
    });
  if (wants(s, 'named-location'))
    state.namedLocations = await readPart('named-location', async () =>
      (
        await graph.all<{
          id: string;
          displayName: string;
          isTrusted?: boolean;
          ipRanges?: Array<{ cidrAddress?: string }>;
        }>({ path: '/identity/conditionalAccess/namedLocations' })
      ).map((l) => ({
        id: l.id,
        displayName: l.displayName,
        isTrusted: !!l.isTrusted,
        cidrs: (l.ipRanges ?? []).map((r) => r.cidrAddress ?? '').filter(Boolean),
      })),
    );
  if (wants(s, 'intune')) {
    state.intune = await readPart('intune', () => readIntune(graph));
    state.testGroupId = (await findGroup(graph, desired.testGroup.uniqueName))?.id;
    const groupId = state.testGroupId;
    if (groupId)
      state.testGroupMembers = await readPart('intune', async () =>
        (
          await graph.all<GroupMember & { '@odata.type'?: string }>({
            path: `/groups/${groupId}/members`,
            query: { $select: 'id,displayName,userPrincipalName,employeeType' },
          })
        ).map((m) => ({
          type: m['@odata.type'] ?? 'unknown',
          ...(m.userPrincipalName ? { userPrincipalName: m.userPrincipalName } : {}),
          ...(m.displayName ? { displayName: m.displayName } : {}),
          employeeType: m.employeeType ?? null,
        })),
      );
  }
  // Always looked up: opted in, it is read in full; otherwise only whether a leftover approver exists.
  state.approver = await fetchApproverState(graph, desired, approverEnv, wants(s, 'approver'));
  return state;
}

export interface FixtureApplyContext {
  graph: GraphClient;
  writeEnv: (updates: Record<string, string>) => void;
  log: (line: string) => void;
  retry?: RetryOptions;
  password?: () => string;
  now?: () => Date;
}

const GUID = new RegExp(GUID_PATTERN, 'gi');
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;
/** A Graph message for the terminal: first line, ids and addresses masked, cut short. */
const quiet = (message: string) =>
  message.split('\n')[0]!.replace(GUID, '<id>').replace(ADDRESS, '<address>').slice(0, 200);

/** One line for a failed fixture operation. */
export function describeFixtureFailure(fixture: FixtureKey, err: ApiError): string {
  return err.status === 401 || err.status === 403
    ? permissionHint(fixture)
    : `${err.status} ${err.code}: ${quiet(err.message)}`;
}

const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 409 || /already exist|RoleAssignmentExists/i.test(`${err.code} ${err.message}`));
const isGone = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 404 || /RoleAssignmentDoesNotExist|does not exist/i.test(`${err.code} ${err.message}`));
const notVisible = (what: string) =>
  new ApiError(404, 'Request_ResourceNotFound', `${what} is not visible yet (directory replication)`);

/**
 * Executes the non-noop operations in order (after the test identities, so users and AF-Test-Group-01 exist). An
 * operation Graph refuses is reported and the rest of that fixture skipped; other fixtures go on. Returns the
 * fixtures that failed.
 */
export async function applyFixtureOps(
  ops: FixtureOp[],
  desired: DesiredFixtures,
  state: FixtureState,
  ctx: FixtureApplyContext,
): Promise<FixtureKey[]> {
  const { graph, log } = ctx;
  const failed = new Set<FixtureKey>();
  const retry = <T>(fn: () => Promise<T>) =>
    withReplicationRetry(fn, {
      ...ctx.retry,
      onRetry: (_e, n, ms) =>
        log(`      … waiting ${Math.round(ms / 1000)}s for directory replication (attempt ${n})`),
    });
  const specOf = (upn: string) =>
    [...desired.licensed, ...desired.eligibility.map((e) => e.user)].find(
      (u) => u.upn.toLowerCase() === upn.toLowerCase(),
    )!;
  /** A test user provisioning created (it may have been created a moment ago in this run). */
  const user = async (upn: string) => {
    const found = await retry(
      async () => (await findFixtureUser(graph, upn)) ?? Promise.reject(notVisible(upn)),
    );
    if (!isProvisionedAccount(specOf(upn), found))
      throw new ApiError(409, 'NotProvisioned', 'the account was not created by provisioning; left alone');
    return found;
  };
  let country: string | undefined;
  const orgCountry = async () => {
    if (country) return country;
    const { data } = await graph.request<{ value?: Array<{ countryLetterCode?: string }> }>({
      path: '/organization',
      query: { $select: 'countryLetterCode' },
    });
    country = data.value?.[0]?.countryLetterCode || undefined;
    if (!country)
      throw new ApiError(
        400,
        'NoCountry',
        "the organisation has no country set; set the test users' usage location by hand",
      );
    return country;
  };
  const testGroupId = () =>
    retry(
      async () =>
        state.testGroupId ??
        (await findGroup(graph, desired.testGroup.uniqueName))?.id ??
        Promise.reject(notVisible(desired.testGroup.displayName)),
    );
  const eligibilityRequest = (
    principalId: string,
    roleDefinitionId: string,
    extra: Record<string, unknown>,
  ) =>
    graph.request({
      method: 'POST',
      path: '/roleManagement/directory/roleEligibilityScheduleRequests',
      body: {
        principalId,
        roleDefinitionId,
        directoryScopeId: '/',
        justification: 'AdminForge validation fixture (adminforge provision test-identities)',
        ...extra,
      },
    });

  for (const op of ops) {
    if (op.action === 'noop' || op.action === 'skip') continue;
    if (failed.has(op.fixture)) {
      log(`  – not attempted: ${op.title} (an earlier step of this fixture failed)`);
      continue;
    }
    try {
      switch (op.kind) {
        case 'licence': {
          const u = await user(op.upn);
          if (!u.usageLocation) {
            const usageLocation = await orgCountry();
            await retry(() =>
              graph.request({ method: 'PATCH', path: `/users/${u.id}`, body: { usageLocation } }),
            );
          }
          await retry(() =>
            graph.request({
              method: 'POST',
              path: `/users/${u.id}/assignLicense`,
              body: { addLicenses: [{ skuId: op.skuId, disabledPlans: [] }], removeLicenses: [] },
            }),
          );
          log(`  ✓ assigned: ${op.title}`);
          break;
        }
        case 'licenceRemove': {
          const u = await user(op.upn);
          await graph.request({
            method: 'POST',
            path: `/users/${u.id}/assignLicense`,
            body: { addLicenses: [], removeLicenses: [op.skuId] },
          });
          log(`  ✓ removed: ${op.title}`);
          break;
        }
        case 'eligibility': {
          const u = await user(op.upn);
          const start = (ctx.now?.() ?? new Date()).toISOString();
          const assign = (expiration: Record<string, string>) =>
            retry(() =>
              eligibilityRequest(u.id, op.roleDefinitionId, {
                action: 'adminAssign',
                scheduleInfo: { startDateTime: start, expiration },
              }),
            );
          try {
            await assign({ type: 'noExpiration' });
            log(`  ✓ made eligible: ${op.title}`);
          } catch (err) {
            if (isAlreadyExists(err)) {
              log(`  ✓ already eligible: ${op.title}`);
              break;
            }
            // The role's PIM settings may not allow permanent eligibility: the longest they allow by default.
            if (!(
              err instanceof ApiError &&
              err.status === 400 &&
              /ExpirationRule|expiration/i.test(err.message)
            ))
              throw err;
            await assign({ type: 'afterDuration', duration: 'P365D' });
            log(
              `  ✓ made eligible for 365 days (the role's settings don't allow permanent eligibility): ${op.title}`,
            );
          }
          break;
        }
        case 'eligibilityRemove': {
          const u = await user(op.upn);
          try {
            await eligibilityRequest(u.id, op.roleDefinitionId, { action: 'adminRemove' });
          } catch (err) {
            if (!isGone(err)) throw err;
          }
          log(`  ✓ removed: ${op.title}`);
          break;
        }
        case 'namedLocation': {
          await graph.request({
            method: 'POST',
            path: '/identity/conditionalAccess/namedLocations',
            body: {
              '@odata.type': '#microsoft.graph.ipNamedLocation',
              displayName: NAMED_LOCATION.displayName,
              isTrusted: false,
              ipRanges: [
                { '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: NAMED_LOCATION.cidr },
              ],
            },
          });
          log(`  ✓ created: ${op.title}`);
          break;
        }
        case 'namedLocationRemove': {
          try {
            await graph.request({
              method: 'DELETE',
              path: `/identity/conditionalAccess/namedLocations/${op.id}`,
            });
          } catch (err) {
            if (!isGone(err)) throw err;
          }
          log(`  ✓ removed: ${op.title}`);
          break;
        }
        case 'intunePolicy': {
          const spec = INTUNE_POLICIES[op.policy];
          const groupId = await testGroupId();
          const id =
            op.existingId ??
            (await graph.request<{ id: string }>({ method: 'POST', path: spec.path, body: spec.body })).data
              .id;
          // `assign` replaces the policy's assignments: this policy is provisioning's own, AF-Test-Group-01 only.
          await graph.request({
            method: 'POST',
            path: `${spec.path}/${id}/assign`,
            body: {
              assignments: [{ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } }],
            },
          });
          log(`  ✓ ${op.existingId ? 'assigned' : 'created and assigned'}: ${op.title}`);
          break;
        }
        case 'intunePolicyRemove': {
          try {
            await graph.request({ method: 'DELETE', path: `${INTUNE_POLICIES[op.policy].path}/${op.id}` });
          } catch (err) {
            if (!isGone(err)) throw err;
          }
          log(`  ✓ removed: ${op.title}`);
          break;
        }
        case 'note':
          break;
        default:
          await applyApproverOp(op, desired, state.approver!, {
            graph,
            writeEnv: ctx.writeEnv,
            log,
            retry,
            password: ctx.password,
          });
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      failed.add(op.fixture);
      log(`  ✗ ${op.title} — ${describeFixtureFailure(op.fixture, err)}`);
    }
  }
  return [...failed];
}
