import type { Mode } from '@adminforge/connectors';
import type { Playbook, Runbook, Step } from '@adminforge/schemas';

/**
 * Engine data model (§7.8). Everything here is plain JSON so a RunStore can persist it as-is
 * (`runs`, `run_steps`, `run_step_events`, `approvals`).
 */

export type AutomationDefinition = Playbook | Runbook;

/**
 * Run states. `queued → running → (awaiting_approval | awaiting_input | awaiting_arm | awaiting_reauth) → running →
 * succeeded | failed | cancelled | compensated | needs_review`. A run parked on a `wait` step stays `running` and the
 * outcome carries `wakeAt`.
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

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'];
export const PARKED_RUN_STATUSES: readonly RunStatus[] = ['awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth'];
export const isTerminal = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);
export const isParked = (s: RunStatus): boolean => PARKED_RUN_STATUSES.includes(s);

/**
 * Step record states.
 * - `running` in flight (checkpointed before the call, so a crash leaves it visible)
 * - `waiting` parked: approval/manual decision, a `wait` timer, or an identity that must arm / sign in again
 * - `planned` a write step in a dry run (see `plan`)
 * - `retried` an attempt that failed transiently (or was interrupted) and was superseded by a later attempt
 * - `compensated` a completed step whose `compensate` block ran (or was planned, in a dry run)
 * - `needs_review` a non-idempotent step that was in flight when a worker stopped
 */
export const STEP_STATUSES = [
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

/** Who a step runs as. Interactive runs: the initiator, then the approver after an approval (ADR-010). */
export interface Actor {
  kind: 'delegated' | 'automation';
  oid: string | null;
  upn: string | null;
}

export interface RunError {
  code: string;
  message: string;
  /** Step id that failed (`expect.failedStep` in content tests). */
  stepId?: string;
  /** Step path, e.g. `loop[3].disable`. */
  path?: string;
  /** HTTP status of an upstream failure. */
  status?: number;
  /** Microsoft request-id of an upstream failure. */
  requestId?: string;
  /** Set while compensation is in progress (a resumed run continues compensating). */
  compensating?: boolean;
  /** Compensations that failed (run → needs_review). */
  compensationFailures?: Array<{ stepId: string; path: string; message: string }>;
  details?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  kind: 'playbook' | 'runbook';
  definitionKey: string;
  definitionVersion: string;
  definitionSha256: string;
  status: RunStatus;
  dryRun: boolean;
  /** delegated = the engineer's session (ADR-010); automation = the app-only automation identity (ADR-011). */
  identity: 'delegated' | 'automation';
  /** interactive | bulk | schedule | child */
  trigger: string;
  initiator: Actor;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  correlationId: string;
  parentRunId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export type RunPatch = Partial<Pick<RunRecord, 'status' | 'outputs' | 'error' | 'startedAt' | 'endedAt'>>;

/** One row per step attempt (`run_steps`). The latest record (highest seq) for a path is authoritative. */
export interface StepRecord {
  seq: number;
  stepId: string;
  /** `disable`, or `loop[3].disable` inside a forEach, `disable#compensate` for a compensation. */
  path: string;
  type: string;
  attempt: number;
  status: StepStatus;
  actorOid: string | null;
  mode: Mode;
  /** Rendered request (redacted), or engine state: forEach `{items}`, wait `{wakeAt}`, approval `{expiresAt}`, branch `{taken}`. */
  request: unknown;
  /** Dry-run plan entries produced by this record. */
  plan: PlanEntry[] | null;
  output: unknown;
  error: RunError | null;
  msRequestId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** A write the run would make (dry run) — shown on the playbook page before **Run**. */
export interface PlanEntry {
  stepId: string;
  /** Step path (unique per run). */
  stepPath: string;
  describe: string | null;
  service: string;
  method: string;
  /** Path relative to the service root (graph/arm/…), the script for runner steps, `<connection>/<operation>` for functions. */
  path?: string;
  /** http steps: the absolute URL. */
  url?: string;
  query?: Record<string, unknown>;
  /** Redacted. */
  body?: unknown;
  /** A compensating write planned because a later step failed. */
  compensation?: boolean;
  /** Set when the entry comes from a child playbook run. */
  childRunId?: string;
}

/** Human decisions recorded by the API and read back when a run resumes. */
export type Decision =
  | { kind: 'approval'; approved: true; actor: Actor; comment?: string | null; decidedAt: string }
  | { kind: 'approval'; approved: false; actor: Actor | null; comment?: string | null; decidedAt: string; expired?: boolean }
  | { kind: 'manual'; confirmed: boolean; actor: Actor; notes?: string | null; values?: Record<string, unknown>; decidedAt: string };

/** What the engine asks a human for when it parks on approval/manual. Opened idempotently per (run, path). */
export type HumanTask =
  | {
      kind: 'approval';
      path: string;
      stepId: string;
      message: string | null;
      approvers: string[];
      minApprovals: number;
      expiresAt: string | null;
      requestedBy: Actor;
    }
  | {
      kind: 'manual';
      path: string;
      stepId: string;
      instructions: string;
      checklist: string[];
      requestedBy: Actor;
    };

export type RunEventType = 'status' | 'log' | 'progress' | 'output';

export interface RunEventInput {
  type: RunEventType;
  stepSeq?: number | null;
  level?: 'debug' | 'info' | 'warn' | 'error' | null;
  data: Record<string, unknown>;
}

/** What `Engine.execute` returns. */
export interface RunOutcome {
  status: RunStatus;
  /** A `wait` step parked the run: execute again at (or after) this time. */
  wakeAt?: Date;
  outputs?: Record<string, unknown> | null;
  error?: RunError | null;
}

/** Engine limits (§7.8). */
export interface Limits {
  /** Steps per definition (walked, including nested). */
  maxSteps: number;
  /** forEach items. */
  maxItems: number;
  /** forEach concurrency. */
  maxConcurrency: number;
  /** Run time excluding time parked on approval/manual steps. */
  maxRunMs: number;
  /** Stored output per step (larger outputs are truncated in the record, kept whole in memory). */
  maxOutputBytes: number;
  /** Nested child playbooks. */
  maxChildDepth: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 200,
  maxItems: 1000,
  maxConcurrency: 10,
  maxRunMs: 4 * 3_600_000,
  maxOutputBytes: 256 * 1024,
  maxChildDepth: 3,
};

export type { Mode, Step };
