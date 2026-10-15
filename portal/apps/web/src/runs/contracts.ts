import { arr, bool, listOf, num, parser, pick, rec, str } from './json';

/**
 * Runs as the SPA sees them (§7.8, engine `RunRecord` / `StepRecord` / `PlanEntry`):
 *   GET /api/runs?scope=&status=&playbook=&cursor=   → { items: RunSummary[], cursor? }
 *   GET /api/runs/:id                                 → { run, steps, plan }
 *   GET /api/runs/:id/events (SSE)                    → run | step | log | progress, with `id` for Last-Event-ID
 */

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
  'succeeded',
  'failed',
  'cancelled',
  'compensated',
  'needs_review',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'compensated',
  'needs_review',
];
export const PARKED_STATUSES: readonly RunStatus[] = [
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
];

export const isTerminal = (s: string) => (TERMINAL_STATUSES as readonly string[]).includes(s);
export const isParked = (s: string) => (PARKED_STATUSES as readonly string[]).includes(s);
export const asRunStatus = (s: unknown): RunStatus =>
  typeof s === 'string' && (RUN_STATUSES as readonly string[]).includes(s) ? (s as RunStatus) : 'queued';

export const STEP_STATUSES = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'planned',
  'retried',
  'cancelled',
  'compensated',
  'needs_review',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
const asStepStatus = (s: unknown): StepStatus =>
  typeof s === 'string' && (STEP_STATUSES as readonly string[]).includes(s) ? (s as StepStatus) : 'pending';

export interface RunActor {
  oid: string | null;
  upn: string | null;
  name: string | null;
}

export interface RunError {
  code: string;
  message: string;
  hint?: string;
  stepId?: string;
  path?: string;
  status?: number;
  requestId?: string;
  correlationId?: string;
}

export interface RunProgress {
  done: number;
  total: number;
  failed?: number;
}

export interface RunSummary {
  id: string;
  kind: 'playbook' | 'runbook';
  /** Definition key, e.g. identity.disable-user. */
  key: string;
  version: string | null;
  title: string;
  status: RunStatus;
  dryRun: boolean;
  /** interactive | bulk | schedule | child */
  trigger: string;
  identity: 'delegated' | 'automation';
  initiator: RunActor;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  progress: RunProgress | null;
  /** Label of the step in flight, for the dock ("step 4/9 · Revoke sessions"). */
  currentStep: string | null;
  parentRunId: string | null;
}

export interface PlanEntry {
  stepId: string;
  stepPath: string;
  describe: string | null;
  service: string;
  method: string;
  path?: string;
  url?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  compensation?: boolean;
  childRunId?: string;
}

export interface RunStep {
  seq: number;
  stepId: string;
  path: string;
  type: string;
  status: StepStatus;
  mode: 'read' | 'write';
  name: string | null;
  describe: string | null;
  attempt: number;
  plan: PlanEntry[] | null;
  output: unknown;
  error: RunError | null;
  actorUpn: string | null;
  startedAt: string | null;
  endedAt: string | null;
  childRunId: string | null;
}

export interface RunConfirm {
  type: 'none' | 'click' | 'typed';
  value?: string;
  message?: string;
}

/** A human task on a run (`tasks` in GET /api/runs/:id): an approval gate or a manual checklist step. */
export interface RunTask {
  id: string;
  kind: 'approval' | 'manual';
  /** Step path (what POST …/approvals/:stepId and …/manual/:stepId take). */
  stepId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  title: string | null;
  message: string | null;
  instructions: string | null;
  checklist: string[];
  approvers: string[];
  minApprovals: number;
  expiresAt: string | null;
  createdAt: string | null;
  requestedBy: string | null;
  /** Approval: write steps follow, so the approver must be armed (ADR-010). */
  writesAfter: boolean | null;
  /** Server's verdict on whether the caller may decide (role, not the initiator, not decided yet). */
  canDecide: boolean | null;
  decisions: Array<{
    approved: boolean;
    actor: string | null;
    comment: string | null;
    decidedAt: string | null;
  }>;
}

/** What a parked run waits for (`run.waiting`). */
export interface RunWaiting {
  kind: 'approval' | 'manual' | 'arm' | 'reauth' | 'wait' | 'child';
  path: string;
  stepId: string;
  since: string | null;
  wakeAt: string | null;
}

export interface RunDetailRun extends RunSummary {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  correlationId: string | null;
  /** Rendered confirmation (when the server provides it after a dry run). */
  confirm: RunConfirm | null;
  waiting: RunWaiting | null;
}

export interface LogLine {
  id: string;
  ts: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  stepSeq: number | null;
  stepId: string | null;
  message: string;
}

export interface RunDetail {
  run: RunDetailRun;
  steps: RunStep[];
  plan: PlanEntry[];
  tasks: RunTask[];
  /** Child runs (bulk items, embedded playbooks). */
  children: RunSummary[];
  logs: LogLine[];
}

function readActor(o: Record<string, unknown>): RunActor {
  const a = rec(o.initiator);
  return {
    oid: pick(a, 'oid') ?? pick(o, 'initiatorOid') ?? null,
    upn: pick(a, 'upn') ?? pick(o, 'initiatorUpn', 'requestedBy') ?? null,
    name: pick(a, 'name', 'displayName') ?? pick(o, 'initiatorName') ?? null,
  };
}

export function readError(v: unknown): RunError | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { code: 'error', message: v };
  const e = rec(v);
  const message = str(e.message);
  if (!message) return null;
  return {
    code: str(e.code) ?? 'error',
    message,
    hint: str(e.hint),
    stepId: str(e.stepId),
    path: str(e.path),
    status: num(e.status),
    requestId: str(e.requestId),
    correlationId: str(e.correlationId),
  };
}

function readProgress(v: unknown): RunProgress | null {
  const p = rec(v);
  const done = num(p.done) ?? num(p.completed);
  const total = num(p.total);
  return done !== undefined && total !== undefined && total > 0
    ? { done, total, failed: num(p.failed) }
    : null;
}

export function readRunSummary(raw: unknown): RunSummary | null {
  const o = rec(raw);
  const id = pick(o, 'id', 'runId');
  if (!id) return null;
  const key = pick(o, 'definitionKey', 'playbook', 'runbook', 'key') ?? 'unknown';
  return {
    id,
    kind: o.kind === 'runbook' || typeof o.runbook === 'string' ? 'runbook' : 'playbook',
    key,
    version: pick(o, 'definitionVersion', 'version') ?? null,
    title: pick(o, 'title', 'definitionTitle') ?? key,
    status: asRunStatus(o.status),
    dryRun: bool(o.dryRun) ?? false,
    trigger: pick(o, 'trigger') ?? 'interactive',
    identity: o.identity === 'automation' ? 'automation' : 'delegated',
    initiator: readActor(o),
    createdAt: pick(o, 'createdAt') ?? pick(o, 'startedAt') ?? null,
    startedAt: pick(o, 'startedAt') ?? null,
    endedAt: pick(o, 'endedAt') ?? null,
    progress: readProgress(o.progress),
    currentStep: pick(o, 'currentStep', 'currentStepName') ?? null,
    parentRunId: pick(o, 'parentRunId') ?? null,
  };
}

export function readPlanEntry(raw: unknown): PlanEntry | null {
  const o = rec(raw);
  const stepId = pick(o, 'stepId');
  if (!stepId) return null;
  return {
    stepId,
    stepPath: pick(o, 'stepPath') ?? stepId,
    describe: pick(o, 'describe') ?? null,
    service: pick(o, 'service') ?? 'graph',
    method: pick(o, 'method') ?? 'POST',
    path: str(o.path),
    url: str(o.url),
    query: o.query && typeof o.query === 'object' ? (o.query as Record<string, unknown>) : undefined,
    body: o.body,
    compensation: bool(o.compensation),
    childRunId: str(o.childRunId),
  };
}

export function readStep(raw: unknown, i: number): RunStep | null {
  const o = rec(raw);
  const stepId = pick(o, 'stepId', 'id');
  if (!stepId) return null;
  const plan = Array.isArray(o.plan)
    ? arr(o.plan)
        .map(readPlanEntry)
        .filter((p): p is PlanEntry => !!p)
    : null;
  return {
    seq: num(o.seq) ?? i,
    stepId,
    path: pick(o, 'path') ?? stepId,
    type: pick(o, 'type') ?? 'step',
    status: asStepStatus(o.status),
    mode: o.mode === 'write' ? 'write' : 'read',
    name: pick(o, 'name') ?? null,
    describe: pick(o, 'describe') ?? null,
    attempt: num(o.attempt) ?? 1,
    plan,
    output: o.output,
    error: readError(o.error),
    actorUpn: pick(o, 'actorUpn') ?? null,
    startedAt: pick(o, 'startedAt') ?? null,
    endedAt: pick(o, 'endedAt') ?? null,
    childRunId: pick(o, 'childRunId') ?? pick(rec(o.output), 'runId') ?? null,
  };
}

function readConfirm(v: unknown): RunConfirm | null {
  const c = rec(v);
  const type = c.type === 'typed' || c.type === 'click' || c.type === 'none' ? c.type : null;
  if (!type) return null;
  return { type, value: str(c.value), message: str(c.message) };
}

export function readTask(raw: unknown): RunTask | null {
  const o = rec(raw);
  const policy = rec(o.policy);
  const id = pick(o, 'id');
  const stepId = pick(o, 'stepId') ?? pick(policy, 'path', 'stepId');
  if (!id || !stepId) return null;
  const st = o.status;
  const status =
    st === 'approved' || st === 'rejected' || st === 'expired' || st === 'cancelled' ? st : 'pending';
  return {
    id,
    kind: (o.kind ?? policy.kind) === 'manual' ? 'manual' : 'approval',
    stepId,
    status,
    title: pick(o, 'title') ?? pick(policy, 'title') ?? null,
    message: pick(o, 'message') ?? pick(policy, 'message') ?? null,
    instructions: pick(policy, 'instructions') ?? pick(o, 'instructions') ?? null,
    checklist: arr(policy.checklist ?? o.checklist).filter((x): x is string => typeof x === 'string'),
    approvers: arr(policy.approvers ?? o.approvers).filter((x): x is string => typeof x === 'string'),
    minApprovals: num(policy.minApprovals) ?? num(o.minApprovals) ?? 1,
    expiresAt: pick(o, 'expiresAt') ?? pick(policy, 'expiresAt') ?? null,
    createdAt: pick(o, 'createdAt') ?? null,
    requestedBy: pick(o, 'requestedBy') ?? pick(policy, 'requestedByUpn') ?? null,
    writesAfter: bool(policy.writesAfter) ?? bool(o.writesAfter) ?? null,
    canDecide: bool(o.canDecide) ?? null,
    decisions: arr(o.decisions).map((d) => {
      const r = rec(d);
      return {
        approved: r.approved === true || r.decision === 'approve' || r.decision === 'confirm',
        actor: pick(rec(r.actor), 'upn') ?? pick(r, 'upn', 'actorUpn', 'actor') ?? null,
        comment: pick(r, 'comment') ?? null,
        decidedAt: pick(r, 'at', 'decidedAt') ?? null,
      };
    }),
  };
}

function readWaiting(v: unknown): RunWaiting | null {
  const o = rec(v);
  const kind = pick(o, 'kind');
  const path = pick(o, 'path');
  if (!kind || !path) return null;
  return {
    kind: (['approval', 'manual', 'arm', 'reauth', 'wait', 'child'].includes(kind)
      ? kind
      : 'wait') as RunWaiting['kind'],
    path,
    stepId: pick(o, 'stepId') ?? path,
    since: pick(o, 'since') ?? null,
    wakeAt: pick(o, 'wakeAt') ?? null,
  };
}

export function readLog(raw: unknown, fallbackId: string): LogLine | null {
  const o = rec(raw);
  const data = rec(o.data);
  const output = data.output ?? o.output;
  const base = pick(o, 'message', 'text', 'line') ?? pick(data, 'message', 'text', 'line');
  const message =
    output !== undefined && output !== null
      ? `${base ? `${base}: ` : ''}${typeof output === 'string' ? output : JSON.stringify(output)}`
      : (base ?? (Object.keys(data).length ? JSON.stringify(data) : undefined));
  if (!message) return null;
  const level = (str(o.level) ?? str(data.level) ?? 'info') as LogLine['level'];
  return {
    id: pick(o, 'id') ?? (num(o.id) !== undefined ? String(o.id) : fallbackId),
    ts: pick(o, 'ts') ?? pick(data, 'ts') ?? null,
    level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    stepSeq: num(o.stepSeq) ?? num(data.stepSeq) ?? null,
    stepId: pick(o, 'stepId', 'path') ?? pick(data, 'stepId', 'path') ?? null,
    message,
  };
}

export function readRunDetail(input: unknown): RunDetail {
  const o = rec(input);
  const runRaw = rec(o.run ?? input);
  const summary = readRunSummary(runRaw);
  if (!summary) throw new TypeError('Expected { run: { id, status } }');
  const steps = arr(o.steps)
    .map(readStep)
    .filter((s): s is RunStep => !!s);
  const topPlan = arr(o.plan)
    .map(readPlanEntry)
    .filter((p): p is PlanEntry => !!p);
  const plan = topPlan.length ? topPlan : steps.flatMap((s) => s.plan ?? []);
  return {
    run: {
      ...summary,
      inputs: rec(runRaw.inputs),
      outputs:
        runRaw.outputs && typeof runRaw.outputs === 'object'
          ? (runRaw.outputs as Record<string, unknown>)
          : null,
      error: readError(runRaw.error),
      correlationId: pick(runRaw, 'correlationId') ?? null,
      confirm: readConfirm(runRaw.confirm ?? o.confirm),
      waiting: readWaiting(runRaw.waiting),
    },
    steps,
    plan,
    tasks: arr(o.tasks ?? o.approvals)
      .map(readTask)
      .filter((t): t is RunTask => !!t),
    children: arr(o.children)
      .map(readRunSummary)
      .filter((c): c is RunSummary => !!c),
    logs: arr(o.logs ?? o.events)
      .map((l, i) => readLog(l, `initial-${i}`))
      .filter((l): l is LogLine => !!l),
  };
}

export const RunDetailResponse = parser(readRunDetail);
export const RunListResponse = listOf(readRunSummary);

/** `{ runId }` from POST /api/runs and /api/runs/bulk. */
export const StartRunResponse = parser((input) => {
  const o = rec(input);
  const runId = pick(o, 'runId', 'id') ?? pick(rec(o.run), 'id');
  if (!runId) throw new TypeError('Expected { runId }');
  return { runId };
});

/** The latest record per step path (retries leave earlier attempts behind). */
export function latestSteps(steps: RunStep[]): RunStep[] {
  const byPath = new Map<string, RunStep>();
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) byPath.set(s.path, s);
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

/** Display name of a step: its name, what it does, or its id. */
export const stepLabel = (s: Pick<RunStep, 'name' | 'describe' | 'stepId'>) =>
  s.name ?? s.describe ?? s.stepId;

/** Name / describe of each step id in a definition (run records only carry ids). */
export type StepIndex = Map<
  string,
  { name: string | null; describe: string | null; type: string; mode: 'read' | 'write' }
>;

/** Label for a step id using the definition when it's known. */
export function labelOf(index: StepIndex | null | undefined, stepId: string): string {
  if (stepId === '$approval') return 'Approval before changes';
  const d = index?.get(stepId);
  return d?.name ?? d?.describe ?? stepId;
}
