import type {
  Actor,
  HumanTask,
  PlanEntry,
  RunError,
  RunEventInput,
  RunRecord,
  RunStatus,
  StepRecord,
} from '@adminforge/engine';
import type { Tx } from '../db/client';
import type { ConfirmView } from './confirm';

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
  /** With `automation`: the named app identity it ran as (ADR-014); null = the automation identity. */
  identityName: string | null;
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

export type NewRun = Omit<
  RunRow,
  'createdAt' | 'updatedAt' | 'startedAt' | 'endedAt' | 'outputs' | 'error' | 'status'
> & { status?: RunStatus };

export type RunRowPatch = Partial<
  Pick<RunRow, 'status' | 'outputs' | 'error' | 'startedAt' | 'endedAt' | 'sessionHash'>
>;

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

/**
 * F-08: the run statuses that count towards a person's open runs. Runs parked on a person (`awaiting_*`) and finished
 * runs don't count.
 */
export const RUN_STATUS_OPEN: readonly RunStatus[] = ['queued', 'running'];

/** What `insertOpenRun` did: inserted (or found, with `ifAbsent`) the run, or refused it at `open` open runs. */
export type OpenRunInsert = { ok: true; row: RunRow } | { ok: false; open: number };

/** Persistence used by the RunService, the worker and the engine store adapter. */
export interface RunRepository {
  insertRun(run: NewRun): Promise<RunRow>;
  /** Inserts unless a run with the same id exists; returns the stored row either way. */
  insertRunIfAbsent(run: NewRun): Promise<RunRow>;
  /**
   * F-08: inserts a run a person starts from the portal unless its initiator already has `max` open runs — root runs
   * (a bulk run counts once, child runs not at all) they started themselves (`identity: delegated`; scheduled runs
   * don't count) that are queued or running (RUN_STATUS_OPEN). Counted and inserted in one write transaction, so
   * starts at the same moment can't pass the cap together. With `ifAbsent`, a run with the same id is returned as it
   * is (a replayed confirmation).
   */
  insertOpenRun(run: NewRun, limit: { max: number; ifAbsent?: boolean }): Promise<OpenRunInsert>;
  /** F-08: the open runs of `initiatorOid`, counted as insertOpenRun counts them. */
  countOpenRuns(initiatorOid: string): Promise<number>;
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

  /** Inserts the event and notifies this process's listeners (the run event bus, the browsers' event stream). */
  appendEvent(runId: string, event: RunEventInput, notify: RunNotification): Promise<EventRow>;
  listEvents(runId: string, afterId: number, limit: number): Promise<EventRow[]>;

  /** Idempotent per (run, step path). */
  upsertTask(runId: string, task: HumanTask, policy: TaskPolicy): Promise<TaskRow>;
  getTask(runId: string, path: string): Promise<TaskRow | null>;
  getTaskById(id: string): Promise<TaskRow | null>;
  /** CAS on status when `expect` is given. */
  updateTask(
    id: string,
    patch: Partial<Pick<TaskRow, 'decisions' | 'status' | 'decidedAt'>>,
    expect?: TaskStatus,
  ): Promise<TaskRow | null>;
  listTasks(filter: TaskFilter): Promise<TaskRow[]>;

  /**
   * Exclusive right to drive a run, or null when another worker has it. `lost` aborts when the right lapsed (a holder
   * stalled past its lease, and another process took the run over): the worker then stops at the next checkpoint.
   */
  tryLock(runId: string): Promise<{ release(): Promise<void>; lost?: AbortSignal } | null>;

  /**
   * S-08 (a SessionMover): the session's id was rotated (arming). Its unfinished runs and its decisions on their tasks
   * move to the new hash inside the rotation's transaction (`tx`; null for the memory repository), so the steps still
   * to come act through the new id (identity.ts). Finished runs keep the hash they ran under: they never act again.
   */
  moveSessionTx(from: string, to: string, tx: Tx | null): void;
}

/**
 * A run notification (small): the platform's GET /api/events relays it as `run.updated` (filter on `initiatorOid` for
 * the run dock); run SSE streams use it to wake up and read new rows from `run_step_events`.
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

/** `status=active` in GET /api/runs: every non-terminal state. */
export const RUN_STATUS_ACTIVE: RunStatus[] = [
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
];

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
  /** Automation runs: the named app identity it ran as (ADR-014); null for the automation identity. */
  identityName: string | null;
  initiatorOid: string | null;
  initiatorUpn: string | null;
  parentRunId: string | null;
  scheduleId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

/**
 * S-25: how much of a run the caller sees. `full`: inputs, outputs, error details, step requests and outputs, plan,
 * task messages, logs. `metadata`: the playbook, who, when, status, step names and states, and references only.
 */
export type RunAccess = 'full' | 'metadata';

export interface RunView extends RunSummary {
  access: RunAccess;
  definitionSha256: string;
  correlationId: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  /** The dry run this execution was confirmed from (playbooks with a confirm block), else null. */
  previewRunId: string | null;
  /**
   * GET /api/runs/:id on the caller's own succeeded preview of a playbook with a confirm block: the confirmation
   * rendered from it (message, and for typed confirms the text to type); null otherwise.
   */
  confirm?: ConfirmView | null;
  /** What the run is parked on, when it is. */
  waiting: {
    kind: 'approval' | 'manual' | 'arm' | 'reauth' | 'wait' | 'child';
    path: string;
    stepId: string;
    since: string | null;
    wakeAt?: string | null;
  } | null;
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
  /** Metadata views: the child run a `playbook` step started (its output, which says so, isn't shown). */
  childRunId?: string;
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
  policy: DistributiveOmit<TaskPolicy, 'initiatorOid' | 'excludes'>;
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
  row.identity === 'automation'
    ? { kind: 'automation', oid: row.initiatorOid, upn: row.initiatorUpn }
    : { kind: 'delegated', oid: row.initiatorOid, upn: row.initiatorUpn };

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
    identityName: row.identityName,
    trigger: row.trigger,
    initiator:
      row.identity === 'automation'
        ? { kind: 'automation', oid: 'automation', upn: 'automation identity' }
        : toActor(row),
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
