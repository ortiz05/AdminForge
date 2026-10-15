import type { Actor, HumanTask, PlanEntry, RunError, RunEventInput, RunRecord, RunStatus, StepRecord } from '@adminforge/engine';

/**
 * Storage + API shapes for runs (§8 `runs`, `run_steps`, `run_step_events`, `approvals`). The engine sees RunRecord;
 * the repository additionally keeps the session binding (ADR-010), the schedule link and timestamps.
 */

export interface RunRow {
  id: string;
  kind: 'playbook' | 'runbook';
  definitionKey: string;
  definitionVersion: string;
  definitionSha256: string;
  status: RunStatus;
  dryRun: boolean;
  /** interactive | bulk | schedule | child */
  trigger: 'interactive' | 'bulk' | 'schedule' | 'child';
  identity: 'delegated' | 'automation';
  initiatorOid: string | null;
  initiatorUpn: string | null;
  /** Session the initiator's steps run with (sha256 of the session id; never sent to clients). */
  sessionHash: string | null;
  scheduleId: string | null;
  parentRunId: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  correlationId: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  updatedAt: Date;
}

export type NewRun = Omit<RunRow, 'createdAt' | 'updatedAt' | 'startedAt' | 'endedAt' | 'outputs' | 'error' | 'status'> & { status?: RunStatus };

export type RunRowPatch = Partial<Pick<RunRow, 'status' | 'outputs' | 'error' | 'startedAt' | 'endedAt' | 'sessionHash'>>;

export interface EventRow extends RunEventInput {
  id: number;
  runId: string;
  ts: Date;
}

/** A decision recorded on an approval/manual task. `sessionHash` binds the approver's session (server-side only). */
export interface TaskDecision {
  oid: string;
  upn: string | null;
  decision: 'approve' | 'reject' | 'confirm' | 'decline';
  comment?: string | null;
  values?: Record<string, unknown>;
  sessionHash?: string | null;
  at: string;
}

export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/** `approvals` row for a run's approval gate or manual step (subject_type = run, step_id = step path). */
export interface TaskRow {
  id: string;
  subjectType: 'run' | 'schedule' | 'definition';
  subjectId: string;
  stepId: string | null;
  /** HumanTask + display context (title, definition, initiator). */
  policy: TaskPolicy;
  decisions: TaskDecision[];
  status: TaskStatus;
  requestedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TaskPolicy = DistributiveOmit<HumanTask, 'requestedBy'> & {
  title: string;
  definitionKey: string;
  definitionVersion: string;
  requestedByUpn: string | null;
  initiatorOid: string | null;
  /** Approval: whether write steps can run after this gate (approver must be armed). */
  writesAfter?: boolean;
};

export interface RunFilter {
  /** Only runs started by this user. */
  initiatorOid?: string;
  statuses?: RunStatus[];
  definitionKey?: string;
  parentRunId?: string;
  /** Top-level runs only (default true unless parentRunId is given). */
  topLevel?: boolean;
  from?: Date;
  to?: Date;
  limit: number;
  /** Keyset cursor (opaque to clients). */
  cursor?: { createdAt: Date; id: string };
}

export interface TaskFilter {
  status?: TaskStatus;
  kind?: 'approval' | 'manual';
  runId?: string;
  runIds?: string[];
}

/** Persistence used by the RunService, the worker and the engine store adapter. */
export interface RunRepository {
  insertRun(run: NewRun): Promise<RunRow>;
  /** Inserts unless a run with the same id exists; returns the stored row either way. */
  insertRunIfAbsent(run: NewRun): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  /** CAS on status when `expect` is given; null when the row is missing or the CAS failed. */
  updateRun(id: string, patch: RunRowPatch, expect?: readonly RunStatus[]): Promise<RunRow | null>;
  listRuns(filter: RunFilter): Promise<RunRow[]>;
  /** The run and all its descendants (children of children…), root first. */
  runTree(rootId: string): Promise<RunRow[]>;
  /** Runs in these statuses last updated before `before` (crash recovery / wake-ups). */
  staleRuns(statuses: readonly RunStatus[], before: Date, limit: number): Promise<RunRow[]>;

  saveStep(runId: string, record: StepRecord): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;

  /** Inserts the event and NOTIFYs `run_events` (Postgres) in the same transaction. */
  appendEvent(runId: string, event: RunEventInput, notify: RunNotification): Promise<EventRow>;
  listEvents(runId: string, afterId: number, limit: number): Promise<EventRow[]>;

  /** Idempotent per (run, step path). */
  upsertTask(runId: string, task: HumanTask, policy: TaskPolicy): Promise<TaskRow>;
  getTask(runId: string, path: string): Promise<TaskRow | null>;
  getTaskById(id: string): Promise<TaskRow | null>;
  /** CAS on status when `expect` is given. */
  updateTask(id: string, patch: Partial<Pick<TaskRow, 'decisions' | 'status' | 'decidedAt'>>, expect?: TaskStatus): Promise<TaskRow | null>;
  listTasks(filter: TaskFilter): Promise<TaskRow[]>;

  /** Exclusive per-run execution lock (advisory lock in Postgres). Null when another worker holds it. */
  tryLock(runId: string): Promise<{ release(): Promise<void> } | null>;
}

/**
 * Payload of `NOTIFY run_events` (JSON, small). The platform's GET /api/events can relay it as `run.updated` (filter on
 * `initiatorOid` for the run dock); run SSE streams use it to wake up and read new rows from `run_step_events`.
 */
export interface RunNotification {
  v: 1;
  runId: string;
  eventId?: number;
  /** run = run status changed; step = step status changed; log/progress = streamed output. */
  type: 'run' | 'step' | 'log' | 'progress';
  status?: RunStatus | string;
  initiatorOid?: string | null;
  parentRunId?: string | null;
}

export const RUN_EVENTS_CHANNEL = 'run_events';

/** `status=active` in GET /api/runs: every non-terminal state. */
export const RUN_STATUS_ACTIVE: RunStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth'];

// ── API views (the web UI codes against these) ───────────────────────────────

export interface RunSummary {
  id: string;
  kind: 'playbook' | 'runbook';
  definitionKey: string;
  definitionVersion: string;
  title?: string;
  status: RunStatus;
  dryRun: boolean;
  trigger: RunRow['trigger'];
  identity: RunRow['identity'];
  initiatorOid: string | null;
  initiatorUpn: string | null;
  parentRunId: string | null;
  scheduleId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface RunView extends RunSummary {
  definitionSha256: string;
  correlationId: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  /** The dry run this execution was confirmed from (playbooks with a confirm block), else null. */
  previewRunId: string | null;
  /** What the run is parked on, when it is. */
  waiting: { kind: 'approval' | 'manual' | 'arm' | 'reauth' | 'wait' | 'child'; path: string; stepId: string; since: string | null; wakeAt?: string | null } | null;
}

export interface StepView {
  seq: number;
  stepId: string;
  path: string;
  type: string;
  status: StepRecord['status'];
  mode: StepRecord['mode'];
  attempt: number;
  actorOid: string | null;
  request: unknown;
  plan: PlanEntry[] | null;
  output: unknown;
  error: RunError | null;
  msRequestId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface TaskView {
  id: string;
  subjectType: TaskRow['subjectType'];
  subjectId: string;
  stepId: string | null;
  kind: 'approval' | 'manual';
  title: string;
  status: TaskStatus;
  requestedBy: string;
  requestedByOid: string;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  policy: DistributiveOmit<TaskPolicy, 'initiatorOid'>;
  decisions: Array<Omit<TaskDecision, 'sessionHash'>>;
  /** Whether the caller may decide (role, not the initiator, not already decided). */
  canDecide: boolean;
}

export interface RunDetail {
  run: RunView;
  steps: StepView[];
  plan: PlanEntry[];
  tasks: TaskView[];
  children: RunSummary[];
}

export const toActor = (row: Pick<RunRow, 'identity' | 'initiatorOid' | 'initiatorUpn'>): Actor =>
  row.identity === 'automation' ? { kind: 'automation', oid: row.initiatorOid, upn: row.initiatorUpn } : { kind: 'delegated', oid: row.initiatorOid, upn: row.initiatorUpn };

export function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    definitionKey: row.definitionKey,
    definitionVersion: row.definitionVersion,
    definitionSha256: row.definitionSha256,
    status: row.status,
    dryRun: row.dryRun,
    identity: row.identity,
    trigger: row.trigger,
    initiator: row.identity === 'automation' ? { kind: 'automation', oid: 'automation', upn: 'automation identity' } : toActor(row),
    inputs: row.inputs,
    outputs: row.outputs,
    error: row.error,
    correlationId: row.correlationId,
    parentRunId: row.parentRunId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}
