import {
  redact,
  redactInputs,
  secretInputValues,
  type AutomationDefinition,
  type PlanEntry,
  type RunError,
  type StepRecord,
} from '@adminforge/engine';
import type { Params } from '@adminforge/schemas';
import {
  sessionBinding,
  type EventRow,
  type RunAccess,
  type RunRow,
  type RunSummary,
  type RunView,
  type StepView,
  type TaskRow,
  type TaskView,
} from './types';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function runSummary(row: RunRow, title?: string): RunSummary {
  return {
    id: row.id,
    kind: row.kind,
    definitionKey: row.definitionKey,
    definitionVersion: row.definitionVersion,
    ...(title ? { title } : {}),
    status: row.status,
    dryRun: row.dryRun,
    trigger: row.trigger,
    identity: row.identity,
    identityName: row.identityName ?? null,
    initiatorOid: row.initiatorOid,
    initiatorUpn: row.initiatorUpn,
    parentRunId: row.parentRunId,
    scheduleId: row.scheduleId,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    updatedAt: row.updatedAt.toISOString(),
    // S-08: lists say what the run page says ("Waiting to be resumed"), not only "Needs write access".
    ...(row.status === 'awaiting_arm' && sessionBinding(row.sessionHash).prearm
      ? { waitingReason: 'prearm' as const }
      : {}),
  };
}

/** Inputs as shown to people: params declared `redact: true` are masked; bulk items are masked per item. */
export function viewInputs(row: RunRow, params: Params | undefined): Record<string, unknown> {
  if (row.trigger === 'bulk') {
    const { items, ...rest } = row.inputs as { items?: Array<Record<string, unknown>> };
    return { ...rest, items: (items ?? []).map((i) => redactInputs(params, i)) };
  }
  return redactInputs(params, row.inputs);
}

/** Values of the run's `redact: true` inputs (each bulk item's too): masked wherever the run is shown. */
export function runSecrets(row: RunRow, params: Params | undefined): string[] {
  if (row.trigger === 'bulk') {
    const items = (row.inputs as { items?: Array<Record<string, unknown>> }).items ?? [];
    return items.flatMap((i) => secretInputValues(params, i ?? {}));
  }
  return secretInputValues(params, row.inputs ?? {});
}

/** Latest record per path, in seq order. */
export function latestRecords(steps: StepRecord[]): StepRecord[] {
  const byPath = new Map<string, StepRecord>();
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) byPath.set(s.path, s);
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

/** The dry-run plan: entries of the latest record per path, in execution order. */
export const runPlan = (steps: StepRecord[]): PlanEntry[] =>
  latestRecords(steps).flatMap((s) => s.plan ?? []);

function waitingOf(steps: StepRecord[]): RunView['waiting'] {
  const w = latestRecords(steps)
    .filter((s) => s.status === 'waiting')
    .pop();
  if (!w) return null;
  const code = w.error?.code;
  const kind: NonNullable<RunView['waiting']>['kind'] =
    w.type === 'approval'
      ? 'approval'
      : w.type === 'manual'
        ? 'manual'
        : w.type === 'wait'
          ? 'wait'
          : w.type === 'playbook'
            ? 'child'
            : code === 'not_armed'
              ? 'arm'
              : 'reauth';
  const wakeAt = (w.request as { wakeAt?: string | null } | null)?.wakeAt ?? null;
  return {
    kind,
    path: w.path,
    stepId: w.stepId,
    since: iso(w.startedAt),
    ...(kind === 'wait' ? { wakeAt } : {}),
  };
}

// ── S-25: what someone sees of another person's delegated run ──

/** Shown where a metadata-only viewer would read an error's message. */
export const RESTRICTED_DETAIL =
  'The details are shown only to the person who started this run, its approvers and Portal Admins.';

/**
 * An error as a metadata-only viewer sees it: the code and the references (step, HTTP status, Microsoft request-id),
 * never the message or hint — those can name what the run looked at.
 */
export function metadataError(e: RunError | null): RunError | null {
  if (!e) return null;
  return {
    code: e.code,
    message: RESTRICTED_DETAIL,
    ...(e.stepId ? { stepId: e.stepId } : {}),
    ...(e.path ? { path: e.path } : {}),
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(e.requestId ? { requestId: e.requestId } : {}),
  };
}

const pick = (data: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));

/** Fields of run, step and progress events a metadata-only viewer receives (an allowlist: anything new stays out). */
const RUN_EVENT_KEYS = [
  'scope',
  'status',
  'by',
  'previewRunId',
  'confirm',
  'confirmationMatched',
  'blockedOn',
  'path',
  'compensating',
] as const;
const STEP_EVENT_KEYS = ['scope', 'path', 'stepId', 'type', 'status', 'attempt'] as const;
const PROGRESS_EVENT_KEYS = ['path', 'done', 'total', 'failed', 'percent'] as const;

/**
 * A stored run event as a metadata-only viewer's stream carries it (S-25): run and step status changes and progress
 * counts, with errors reduced to their code and references. Logs and script output can hold anything the run saw, so
 * they are not sent (null).
 */
export function metadataEvent(e: EventRow): EventRow | null {
  const data = e.data ?? {};
  if (e.type === 'status') {
    const step = data.scope === 'step';
    const kept = pick(data, step ? STEP_EVENT_KEYS : RUN_EVENT_KEYS);
    const error = metadataError((data.error as RunError | undefined) ?? null);
    return { ...e, data: { ...kept, ...(error ? { error } : {}) } };
  }
  if (e.type === 'progress') return { ...e, data: pick(data, PROGRESS_EVENT_KEYS) };
  return null;
}

export function runView(
  row: RunRow,
  def: AutomationDefinition | null,
  steps: StepRecord[],
  params?: Params,
  access: RunAccess = 'full',
): RunView {
  // Runs stored before outputs and errors were masked by the engine are masked here too.
  const secrets = runSecrets(row, params ?? def?.inputs);
  const full = access === 'full';
  return {
    ...runSummary(row, def?.title),
    access,
    definitionSha256: row.definitionSha256,
    correlationId: row.correlationId,
    inputs: full ? viewInputs(row, params ?? def?.inputs) : {},
    outputs: full && row.outputs ? (redact(row.outputs, secrets) as Record<string, unknown>) : null,
    error: !full
      ? metadataError(row.error)
      : row.error && secrets.length
        ? (redact(row.error, secrets) as RunRow['error'])
        : row.error,
    previewRunId: null,
    waiting:
      row.status === 'succeeded' ||
      row.status === 'failed' ||
      row.status === 'cancelled' ||
      row.status === 'compensated'
        ? null
        : prearmed(row, waitingOf(steps)),
  };
}

/**
 * S-08: a run bound before its session last turned write access on waits for its person to resume it before it
 * writes; the view says so, with when the run started, so the run page can ask them to check it's theirs.
 */
function prearmed(row: RunRow, waiting: RunView['waiting']): RunView['waiting'] {
  if (!waiting || row.status !== 'awaiting_arm' || !sessionBinding(row.sessionHash).prearm) return waiting;
  return { ...waiting, reason: 'prearm', startedAt: iso(row.startedAt ?? row.createdAt) };
}

export function stepView(s: StepRecord, access: RunAccess = 'full'): StepView {
  const full = access === 'full';
  const childRunId =
    !full && s.type === 'playbook' ? (s.output as { runId?: unknown } | null)?.runId : undefined;
  return {
    seq: s.seq,
    stepId: s.stepId,
    path: s.path,
    type: s.type,
    status: s.status,
    mode: s.mode,
    attempt: s.attempt,
    actorOid: s.actorOid,
    request: full ? s.request : null,
    plan: full ? s.plan : null,
    output: full ? s.output : null,
    error: full ? s.error : metadataError(s.error),
    msRequestId: s.msRequestId,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    ...(typeof childRunId === 'string' ? { childRunId } : {}),
  };
}

/**
 * A human task as shown; `manualParams` (the manual step's fields) masks values typed into `redact: true` ones.
 * Metadata views (S-25) keep who asked, who decided, how and when — not the rendered message, instructions or
 * checklist, nor what the deciders wrote or typed.
 */
export function taskView(
  t: TaskRow,
  canDecide: boolean,
  manualParams?: Params,
  access: RunAccess = 'full',
): TaskView {
  // `excludes` (who the change grants access to) is enforced server-side; `canDecide` already reflects it.
  const { initiatorOid: _i, ...rest } = t.policy;
  const { excludes: _e, ...shown } = rest as typeof rest & { excludes?: unknown };
  // Metadata: the fields named here and nothing else, so a field added to tasks later stays out until it is listed.
  const common = {
    path: shown.path,
    stepId: shown.stepId,
    title: shown.title,
    definitionKey: shown.definitionKey,
    definitionVersion: shown.definitionVersion,
    requestedByUpn: shown.requestedByUpn,
  };
  const policy: TaskView['policy'] =
    access === 'full'
      ? shown
      : shown.kind === 'approval'
        ? {
            ...common,
            kind: 'approval',
            message: null,
            approvers: shown.approvers,
            minApprovals: shown.minApprovals,
            expiresAt: shown.expiresAt,
            ...(shown.writesAfter !== undefined ? { writesAfter: shown.writesAfter } : {}),
          }
        : { ...common, kind: 'manual', instructions: '', checklist: [] };
  const decisions = t.decisions.map(({ sessionHash: _s, ...d }) =>
    access !== 'full'
      ? { oid: d.oid, upn: d.upn, decision: d.decision, at: d.at }
      : d.values
        ? { ...d, values: redactInputs(manualParams, d.values) }
        : d,
  );
  return {
    id: t.id,
    subjectType: t.subjectType,
    subjectId: t.subjectId,
    stepId: t.stepId,
    kind: t.policy.kind,
    title: t.policy.title,
    status: t.status,
    requestedBy: t.policy.requestedByUpn ?? t.requestedBy,
    requestedByOid: t.requestedBy,
    createdAt: t.createdAt.toISOString(),
    expiresAt: iso(t.expiresAt),
    decidedAt: iso(t.decidedAt),
    policy,
    decisions,
    canDecide,
  };
}
