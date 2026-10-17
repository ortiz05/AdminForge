/**
 * Microsoft Graph I/O for the `ca-audit` fixture (the plan is provision/ca-audit-plan.ts): reads the tenant's
 * Conditional Access policies, and creates, updates or deletes catalogue policies.
 *
 * Writes are checked, one attempt at a time:
 *   - a create's body passes `assertReportOnly`; an update carries no state at all (`assertNoState`), so a policy
 *     someone switches on meanwhile stays on;
 *   - an update or delete re-reads the policy first — exactly this catalogue name, and report-only (update) or
 *     report-only/off (delete) — otherwise nothing is sent;
 *   - writes go through a Graph client without its own retries (`graphOnce`): a throttled (429) write is retried here,
 *     after waiting and after the ownership check again, so minutes can't pass between a check and a write;
 *   - an update is read back: Graph merges a PATCH into nested objects, so `✓` only when the policy now matches the
 *     catalogue (and is still report-only); otherwise the update fails with what differs.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import {
  CA_AUDIT_POLICIES,
  REPORT_ONLY,
  assertNoState,
  assertReportOnly,
  auditPolicyPatch,
  buildAuditPolicy,
  type AuditIds,
} from './ca-audit-catalog';
import { policyDrift } from './ca-audit-plan';
import type { CaPolicyState, DesiredFixtures, FixtureOp } from './fixtures-model';

const PATH = '/identity/conditionalAccess/policies';
const FULL_SELECT = 'id,displayName,state,conditions,grantControls,sessionControls';

/** Every Conditional Access policy (name, state and the parts the catalogue compares). Read-only. */
export async function readCaPolicies(graph: GraphClient): Promise<CaPolicyState[]> {
  const all = await graph.all<CaPolicyState>({ path: PATH, query: { $select: FULL_SELECT } });
  return all.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    state: p.state,
    conditions: p.conditions ?? null,
    grantControls: p.grantControls ?? null,
    sessionControls: p.sessionControls ?? null,
  }));
}

export interface CaApplyContext {
  /** Reads (the client's own retries are fine for them). */
  graph: GraphClient;
  /** Writes: a client without retries — each attempt is preceded by an ownership check here. */
  graphOnce: GraphClient;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** AF-Test-Group-01's id (waits for replication when it was just created). */
  testGroupId: () => Promise<string>;
  /** AF-Test-Location's id (provisioning's own; waits for replication when it was just created). */
  testLocationId: () => Promise<string>;
}

/** Waits before retrying a throttled write (Graph's Retry-After is usually seconds; two tries, then give up). */
export const THROTTLE_WAITS_MS = [10_000, 60_000] as const;
/** Read-back attempts after an update (Graph can answer the old policy for a moment). */
const READ_BACK_WAITS_MS = [0, 5_000, 15_000] as const;

const isGone = (err: unknown) => err instanceof ApiError && err.status === 404;
const refused = (why: string) => new ApiError(409, 'NotProvisioned', why);

/**
 * Re-reads a policy before writing to it: exactly `displayName` and a state in `allowed` — otherwise nothing is sent
 * (someone renamed it, switched it on or off, or replaced it meanwhile).
 */
async function ownPolicy(ctx: CaApplyContext, id: string, displayName: string, allowed: readonly string[]) {
  const { data } = await ctx.graph.request<CaPolicyState>({
    path: `${PATH}/${id}`,
    query: { $select: 'id,displayName,state' },
  });
  if (data.displayName !== displayName)
    throw refused('renamed since the plan — not provisioning’s any more, left alone');
  if (!allowed.includes(data.state))
    throw refused(
      data.state === 'enabled'
        ? 'switched ON (enforced) since the plan — left alone'
        : `its state is now "${data.state}" — left alone`,
    );
}

/** One write after `check`, re-checking before each retry of a throttled (429) attempt. */
async function checkedWrite(ctx: CaApplyContext, check: () => Promise<void>, write: () => Promise<unknown>) {
  for (let attempt = 0; ; attempt++) {
    await check();
    try {
      return await write();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 429) || attempt >= THROTTLE_WAITS_MS.length) throw err;
      ctx.log(`      … throttled by Graph; trying again in ${THROTTLE_WAITS_MS[attempt]! / 1000}s`);
      await ctx.sleep(THROTTLE_WAITS_MS[attempt]!);
    }
  }
}

/** Reads an updated policy back until it matches the catalogue (or the attempts run out). */
async function readBack(ctx: CaApplyContext, id: string, body: ReturnType<typeof buildAuditPolicy>) {
  let problem = '';
  for (const wait of READ_BACK_WAITS_MS) {
    if (wait) await ctx.sleep(wait);
    const { data } = await ctx.graph.request<CaPolicyState>({
      path: `${PATH}/${id}`,
      query: { $select: FULL_SELECT },
    });
    if (data.state !== REPORT_ONLY) throw refused(`its state is now "${data.state}" — left alone`);
    const drift = policyDrift(body, data);
    if (!drift.length) return;
    problem = drift.join('; ');
  }
  throw new ApiError(
    409,
    'NotApplied',
    `updated, but Graph still holds a different policy (${problem}) — check it in the Entra admin center, or delete it and run provisioning again`,
  );
}

/** Applies one ca-audit operation. Throws ApiError on a Graph refusal (the caller prints ✗ and goes on). */
export async function applyCaAuditOp(
  op: Extract<FixtureOp, { kind: 'caPolicy' | 'caPolicyRemove' }>,
  desired: DesiredFixtures,
  ctx: CaApplyContext,
): Promise<void> {
  const spec = CA_AUDIT_POLICIES.find((p) => p.displayName === op.displayName);
  if (!spec) throw new Error(`Unknown ca-audit policy "${op.displayName}"`);
  if (op.kind === 'caPolicyRemove') {
    try {
      await checkedWrite(
        ctx,
        () => ownPolicy(ctx, op.id, spec.displayName, [REPORT_ONLY, 'disabled']),
        () => ctx.graphOnce.request({ method: 'DELETE', path: `${PATH}/${op.id}` }),
      );
    } catch (err) {
      if (!isGone(err)) throw err; // already gone: removed
    }
    ctx.log(`  ✓ removed: ${op.title}`);
    return;
  }
  const ids: AuditIds = {
    protectedUserIds: desired.protectedUserIds,
    ...(spec.scope === 'testGroup' ? { testGroupId: await ctx.testGroupId() } : {}),
    ...(spec.outsideTestLocation ? { testLocationId: await ctx.testLocationId() } : {}),
  };
  const body = buildAuditPolicy(spec, ids);
  if (op.existingId) {
    const id = op.existingId;
    const patch = auditPolicyPatch(body);
    assertNoState(patch);
    await checkedWrite(
      ctx,
      () => ownPolicy(ctx, id, spec.displayName, [REPORT_ONLY]),
      () => ctx.graphOnce.request({ method: 'PATCH', path: `${PATH}/${id}`, body: patch }),
    );
    await readBack(ctx, id, body);
    ctx.log(`  ✓ updated (report-only, read back): ${op.title}`);
  } else {
    assertReportOnly(body);
    // A throttled create wasn't processed, so it is simply sent again (no policy to check yet).
    await checkedWrite(
      ctx,
      async () => {},
      () => ctx.graphOnce.request({ method: 'POST', path: PATH, body: { ...body } }),
    );
    ctx.log(`  ✓ created (report-only): ${op.title}`);
  }
}
