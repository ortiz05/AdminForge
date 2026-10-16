import {
  redact,
  redactInputs,
  secretInputValues,
  type AutomationDefinition,
  type PlanEntry,
  type StepRecord,
} from '@adminforge/engine';
import type { Params } from '@adminforge/schemas';
import type { RunRow, RunSummary, RunView, StepView, TaskRow, TaskView } from './types';

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
    initiatorOid: row.initiatorOid,
    initiatorUpn: row.initiatorUpn,
    parentRunId: row.parentRunId,
    scheduleId: row.scheduleId,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    updatedAt: row.updatedAt.toISOString(),
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

export function runView(
  row: RunRow,
  def: AutomationDefinition | null,
  steps: StepRecord[],
  params?: Params,
): RunView {
  // Runs stored before outputs and errors were masked by the engine are masked here too.
  const secrets = runSecrets(row, params ?? def?.inputs);
  return {
    ...runSummary(row, def?.title),
    definitionSha256: row.definitionSha256,
    correlationId: row.correlationId,
    inputs: viewInputs(row, params ?? def?.inputs),
    outputs: row.outputs ? (redact(row.outputs, secrets) as Record<string, unknown>) : null,
    error: row.error && secrets.length ? (redact(row.error, secrets) as RunRow['error']) : row.error,
    previewRunId: null,
    waiting:
      row.status === 'succeeded' ||
      row.status === 'failed' ||
      row.status === 'cancelled' ||
      row.status === 'compensated'
        ? null
        : waitingOf(steps),
  };
}

export function stepView(s: StepRecord): StepView {
  return {
    seq: s.seq,
    stepId: s.stepId,
    path: s.path,
    type: s.type,
    status: s.status,
    mode: s.mode,
    attempt: s.attempt,
    actorOid: s.actorOid,
    request: s.request,
    plan: s.plan,
    output: s.output,
    error: s.error,
    msRequestId: s.msRequestId,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
  };
}

/** A human task as shown; `manualParams` (the manual step's fields) masks values typed into `redact: true` ones. */
export function taskView(t: TaskRow, canDecide: boolean, manualParams?: Params): TaskView {
  // `excludes` (who the change grants access to) is enforced server-side; `canDecide` already reflects it.
  const { initiatorOid: _i, ...rest } = t.policy;
  const { excludes: _e, ...policy } = rest as typeof rest & { excludes?: unknown };
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
    decisions: t.decisions.map(({ sessionHash: _s, ...d }) =>
      d.values ? { ...d, values: redactInputs(manualParams, d.values) } : d,
    ),
    canDecide,
  };
}
