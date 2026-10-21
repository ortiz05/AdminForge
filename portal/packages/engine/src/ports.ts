import type { Mode } from '@adminforge/connectors';
import type { Scope } from '@adminforge/expressions';
import type {
  Actor,
  Decision,
  HumanTask,
  Limits,
  PlanEntry,
  RunError,
  RunEventInput,
  RunPatch,
  RunRecord,
  RunStatus,
  StepRecord,
} from './types';

/**
 * Ports: everything the engine needs from the outside world. The engine itself does no I/O.
 * The API wires Postgres, the outbound executor, the PowerShell runner and the session store behind these;
 * tests and `runPlaybookTests` use in-memory fakes.
 */

/** Persistence for runs, step checkpoints, events and human tasks. */
export interface RunStore {
  getRun(runId: string): Promise<RunRecord | null>;
  /**
   * Applies `patch`. With `expect`, only when the stored status is one of them (compare-and-set) — returns null
   * when the CAS failed (e.g. the run was cancelled meanwhile).
   */
  updateRun(runId: string, patch: RunPatch, expect?: readonly RunStatus[]): Promise<RunRecord | null>;
  listSteps(runId: string): Promise<StepRecord[]>;
  /** Insert or replace the record with the same seq. `actor` is who the step ran as (for auditing writes). */
  saveStep(runId: string, record: StepRecord, meta: { actor: Actor | null; dryRun: boolean }): Promise<void>;
  appendEvent(runId: string, event: RunEventInput): Promise<void>;
  /** Called every time a run parks on an approval/manual step; must be idempotent per (runId, path). */
  openTask(runId: string, task: HumanTask): Promise<void>;
  /** The decision recorded for a parked approval/manual step, or null while it is still pending. */
  getDecision(runId: string, path: string): Promise<Decision | null>;
}

export interface Clock {
  now(): Date;
  /** Waits (retry backoff). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Resolves after `ms` (step timeouts). Separate from sleep so a virtual clock can fast-forward backoff without firing timeouts. */
  timer(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Who a call runs as, resolved for one step. `handle` is adapter-specific (the API passes its ExecutionIdentity). */
export interface ResolvedIdentity {
  actor: Actor;
  mode: Mode;
  handle: unknown;
}

/**
 * Resolves an actor + mode to a usable identity. Throws IdentityUnavailable('not_armed' | 'reauth') when the
 * session cannot act right now — the engine then parks the run (`awaiting_arm` / `awaiting_reauth`).
 */
export interface IdentityResolver {
  resolve(run: RunRecord, actor: Actor, mode: Mode): Promise<ResolvedIdentity>;
}

/** A fully rendered outbound call (shape-compatible with the API's ServiceCall). */
export interface ServiceCall {
  service: 'graph' | 'arm' | 'logAnalytics' | 'function' | 'http' | 'exchange' | 'teams' | 'sharepointAdmin';
  method: string;
  /** Relative to the service root (Graph without the version segment). For `function`: the operation name. */
  path: string;
  /** http: absolute URL (host checked against the allowlist by the adapter). */
  url?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  beta?: boolean;
  apiVersion?: string;
  /** function: connection key and named operation (path placeholders in `pathParams`). */
  connection?: string;
  operation?: string;
  pathParams?: Record<string, unknown>;
  /** Only set when published content declares the step `mode: write`. */
  declaredWrite?: boolean;
  /** Set only by the notifier for the one-on-one chat it opens: the body binds chat members, possibly by UPN. */
  chatMembers?: boolean;
  paging?: 'none' | 'all';
  maxItems?: number;
  /** arm: wait for long-running operations. */
  poll?: boolean;
}

export interface ServiceResult {
  data: unknown;
  status?: number;
  requestId?: string;
}

/** Wraps the API's OutboundExecutor (policy → token → connector). */
export interface OutboundPort {
  call(
    identity: ResolvedIdentity,
    call: ServiceCall,
    opts: { correlationId: string; signal: AbortSignal },
  ): Promise<ServiceResult>;
}

export interface RunnerJob {
  /** `<runId>:<path>` (+ attempt) — unique per job. */
  jobId: string;
  script: string;
  sha256: string;
  parameters: Record<string, unknown>;
  services: string[];
  timeoutSeconds?: number;
  mode: Mode;
}

export type RunnerStreamEvent =
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'progress'; percent: number; message: string }
  | { type: 'output'; data: unknown };

export interface RunnerResult {
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  /** Last `output` event's data (or all outputs as an array when the script emitted several). */
  output: unknown;
  error?: { message: string; category: string };
}

/** The PowerShell runner (`POST /v1/jobs`, NDJSON events). */
export interface RunnerPort {
  run(
    identity: ResolvedIdentity,
    job: RunnerJob,
    opts: { signal: AbortSignal; onEvent: (e: RunnerStreamEvent) => Promise<void> | void },
  ): Promise<RunnerResult>;
}

export interface NotifyMessage {
  channel: 'email' | 'teamsChat' | 'teamsChannel';
  to: string[];
  subject?: string;
  message: string;
}

/** Sends `notify` steps as the actor (Graph mail / Teams). The engine ships a Graph implementation over OutboundPort. */
export interface Notifier {
  send(
    identity: ResolvedIdentity,
    message: NotifyMessage,
    opts: { correlationId: string; signal: AbortSignal },
  ): Promise<{ requestId?: string }>;
}

export interface ChildRunRequest {
  parent: RunRecord;
  path: string;
  stepId: string;
  ref: string;
  version?: string;
  inputs: Record<string, unknown>;
  dryRun: boolean;
  /** Who the parent is acting as at this step (the child runs as the same actor). */
  actor: Actor;
  /** 1 for a child of a top-level run. */
  depth: number;
  signal: AbortSignal;
}

export interface ChildRunResult {
  runId: string;
  status: RunStatus;
  outputs: Record<string, unknown> | null;
  error: RunError | null;
  plan: PlanEntry[];
  wakeAt?: Date;
}

/**
 * Runs `type: playbook` steps as child runs. Must be idempotent per (parent run, path): calling it again after the
 * parent resumes continues the same child run.
 */
export interface ChildRunner {
  run(req: ChildRunRequest): Promise<ChildRunResult>;
}

/** One step's show-once secret values, handed to the SecretSink exactly once (never persisted). */
export interface SecretDelivery {
  runId: string;
  stepId: string;
  stepPath: string;
  /** Concrete output path (`$` = the whole output) → value. */
  values: Record<string, unknown>;
  hints: Record<string, string>;
  /** Who the step ran as. */
  producedBy: Actor;
  producedAt: string;
}

/** Where secrets go: the API shows them once to the person who started the run (live stream, or one fetch within 5 minutes). */
export interface SecretSink {
  deliver(
    run: RunRecord,
    secret: SecretDelivery,
  ): Promise<{ status: 'delivered' | 'held' | 'sent' | 'discarded'; reason?: string }>;
}

export interface StepPorts {
  outbound: OutboundPort;
  runner?: RunnerPort;
  notifier: Notifier;
  children?: ChildRunner;
}

/** What a handler sees while preparing/executing one step (or one compensation). */
export interface StepContext {
  run: RunRecord;
  stepId: string;
  path: string;
  mode: Mode;
  dryRun: boolean;
  /** Child playbook nesting depth of this run (0 = top level). */
  depth: number;
  actor: Actor;
  /** Set before `execute` for external handlers. */
  identity: ResolvedIdentity | null;
  scope: Scope;
  render<T = unknown>(value: unknown): Promise<T>;
  signal: AbortSignal;
  correlationId: string;
  ports: StepPorts;
  limits: Limits;
  emit(event: Omit<RunEventInput, 'stepSeq'>): Promise<void>;
}

export interface Prepared {
  /** What the dry-run plan shows for this step (null for pure steps). */
  plan: Omit<PlanEntry, 'stepId' | 'stepPath' | 'describe'> | null;
  /**
   * Redacted request stored on the step record. External handlers always return one (not null): a failed write record
   * without a request never went out, and the resume re-check relies on that (engine.ts › wasSent).
   */
  request: unknown;
  /** Handler-private rendered payload passed to execute. */
  payload: unknown;
}

export interface StepResult {
  output: unknown;
  requestId?: string;
  /** Plan entries produced by the step itself (child playbooks). */
  plan?: PlanEntry[];
  /** The step could not finish yet (child run parked). */
  park?: { status: RunStatus; wakeAt?: Date; error?: { code: string; message: string } };
  /** The step finished unsuccessfully without throwing (child run failed). */
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** One handler per leaf step type. Control steps (branch, forEach, approval, manual, wait) live in the engine. */
export interface StepHandler {
  /** Calls out as an identity (service steps, runner, notify, child playbooks). Pure steps never need one. */
  readonly external: boolean;
  /** Child playbooks plan their own writes (dry runs delegate instead of planning one entry). */
  readonly plansItself?: boolean;
  // Handlers receive the schema step for their type; the registry is keyed by type.
  prepare(step: never, ctx: StepContext): Promise<Prepared>;
  execute(prepared: Prepared, ctx: StepContext): Promise<StepResult>;
}

export type StepHandlerRegistry = Record<string, StepHandler>;

/**
 * Test hook: lets `runPlaybookTests` replace a step's outcome (mocks/errors) after it has been rendered.
 * Returning undefined runs the step normally.
 */
export type StepInterceptor = (
  step: { id: string; type: string; mode: Mode },
  path: string,
  info: { dryRun: boolean; runId: string; compensation: boolean },
) => { output: unknown } | { error: unknown } | undefined;
