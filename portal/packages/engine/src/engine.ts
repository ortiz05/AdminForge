import type { Mode } from '@adminforge/connectors';
import { renderTemplate, type Scope } from '@adminforge/expressions';
import {
  DEFAULT_APPROVAL_EXPIRES_IN,
  flattenSteps,
  parseDuration,
  stepMode,
  type Compensation,
  type RetryPolicy,
  type Step,
} from '@adminforge/schemas';
import { systemClock } from './clock';
import { allSteps, checkDefinition, IMPLICIT_APPROVAL, implicitApprovalIndex } from './definition';
import {
  IdentityUnavailable,
  isTransientError,
  retryAfterMs,
  RunCancelled,
  RunInterrupted,
  StepError,
  toRunError,
} from './errors';
import { builtinHandlers, createGraphNotifier } from './handlers';
import type {
  ChildRunner,
  Clock,
  IdentityResolver,
  Notifier,
  OutboundPort,
  Prepared,
  ResolvedIdentity,
  RunnerPort,
  RunStore,
  SecretSink,
  StepContext,
  StepHandler,
  StepHandlerRegistry,
  StepInterceptor,
  StepResult,
} from './ports';
import { renderMarkdown } from './markdown';
import { containsRedacted, redact, REDACTED, secretInputValues, storableOutput } from './redact';
import { extractSecrets, secretSpec, type SecretSpec } from './secrets';
import {
  DEFAULT_LIMITS,
  isTerminal,
  type Actor,
  type AutomationDefinition,
  type HumanTask,
  type Limits,
  type PlanEntry,
  type RunError,
  type RunEventInput,
  type RunOutcome,
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type StepStatus,
} from './types';

/**
 * The playbook/runbook execution engine (§7.8). `execute()` drives one run from its last checkpoint until it finishes
 * or parks; calling it again after a decision, a re-arm, a wake-up or a crash continues where it stopped.
 *
 * - Every step is checkpointed (`running` before the call, the result after), so a crashed worker resumes from the
 *   last completed step. An in-flight `idempotent: false` step becomes `needs_review` instead of being retried.
 * - Dry runs execute read steps for real and turn write steps into plan entries (output = `dryRunOutput`, else null).
 * - Approvals and manual steps park the run until the API records a decision; after an approval, later steps run as
 *   the approver (delegated runs, ADR-010). Write steps park the run in `awaiting_arm` until the actor is armed;
 *   token failures park it in `awaiting_reauth`.
 * - `onError: compensate` runs completed steps' `compensate` blocks in reverse order.
 * - A pass that continues an earlier one (after a decision, a re-arm, a sign-in, a `wait` or a restart) reads and
 *   checks again before its next write: see `recheck`.
 */

export interface EngineOptions {
  store: RunStore;
  identity: IdentityResolver;
  outbound: OutboundPort;
  clock?: Clock;
  runner?: RunnerPort;
  /** Default: Graph mail/Teams over `outbound`. */
  notifier?: Notifier;
  children?: ChildRunner;
  /** Replace or add leaf handlers (keyed by step type). */
  handlers?: StepHandlerRegistry;
  /** `env` in expressions (tenant id, domains — configuration only). */
  env?: Record<string, unknown>;
  limits?: Partial<Limits>;
  /** Test hook used by runPlaybookTests (mocks/errors). */
  intercept?: StepInterceptor;
  /** `user.roles` in expressions. */
  rolesOf?: (actor: Actor, run: RunRecord) => string[];
  /** Dry runs also dry-run child playbooks (their reads run, their writes join the plan). Default true. */
  dryRunChildren?: boolean;
  /** Receives show-once secrets (`secretOutputs` / `secret: true`). Without it they are discarded after masking. */
  secrets?: SecretSink;
}

export interface ExecuteOptions {
  /**
   * Aborts the step in flight. Its reason says why: a `RunInterrupted` (shutdown, lost run lock) leaves the run
   * resumable from its last checkpoint; any other abort is a person's cancel and ends the run `cancelled`.
   */
  signal?: AbortSignal;
  /**
   * A graceful stop (shutdown): the step in flight may finish, and the run stops at its next checkpoint, resumable.
   * Retry backoffs are cut short. The process aborts `signal` with `RunInterrupted('shutdown')` once its grace is over.
   */
  interrupt?: AbortSignal;
  /** Child playbook depth (0 for a top-level run). */
  depth?: number;
}

type Flow =
  | { kind: 'ok' }
  | { kind: 'park'; status: RunStatus; wakeAt?: Date }
  | { kind: 'fail'; error: RunError; policy: 'fail' | 'compensate'; needsReview?: boolean }
  | { kind: 'cancelled' }
  /** Shutdown or a lost run lock: the run stops without being written and resumes from its last checkpoint. */
  | { kind: 'interrupted'; why: RunInterrupted };

const OK: Flow = { kind: 'ok' };

interface View {
  output: unknown;
  status: StepStatus;
  error?: RunError | null;
}

interface Frame {
  /** '' at top level; `loop[3].` inside an iteration. */
  prefix: string;
  actor: Actor;
  locals: Map<string, View>;
  parent: Frame | null;
  vars: Record<string, unknown>;
  /** A re-check (see `recheck`): stale reads and checks run again; nothing else starts, nothing is sent. */
  recheck?: boolean;
  /**
   * In a re-check: whose access reads go out with (the person the guarded write runs as). `actor` stays who the step
   * ran as the first time, so `user.*` means what it meant then (a transform of `user.oid` before an approval).
   */
  callAs?: Actor;
  /** What this frame reused from an earlier pass that must run again before the next write in its scope. */
  rechecks?: Recheck[];
}

/** A stale read or check (or a finished forEach holding some), run again at most once per pass. */
interface Recheck {
  /** Walk order, so a transform runs after the read it is built from. */
  order: number;
  /** Runs it again, its reads going out with `callAs`'s access (who the write it guards runs as). */
  run: (callAs: Actor) => Promise<Flow>;
  done?: Promise<Flow>;
}

type ApprovalStep = Extract<Step, { type: 'approval' }>;
type ManualStep = Extract<Step, { type: 'manual' }>;
type WaitStep = Extract<Step, { type: 'wait' }>;
type BranchStep = Extract<Step, { type: 'branch' }>;
type ForEachStep = Extract<Step, { type: 'forEach' }>;

const CONTROL = new Set(['branch', 'forEach', 'approval', 'manual', 'wait']);
const REUSABLE: readonly StepStatus[] = ['succeeded', 'skipped', 'planned', 'failed', 'compensated'];
/** A write record in one of these states was sent (or may have been): what was read before it is not read again. */
const SENT: readonly StepStatus[] = ['succeeded', 'failed', 'compensated', 'needs_review'];
const RECHECK_HINT =
  'The run had paused before this change (for an approval, input, write access, a sign-in or a restart), so this was checked again first. Check what changed, then start a new run if the change is still needed.';
const NON_TERMINAL: readonly RunStatus[] = [
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
];
const MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_WAIT_INTERVAL_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_600_000;
const CANCEL_CHECK_MS = 1_000;

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
const iso = (d: Date) => d.toISOString();

/** A step (or child playbook) would send the `[redacted]` placeholder instead of a real value. */
export const redactedValueError = () =>
  new StepError(
    'redacted_value',
    `This step would have sent a hidden value ("${REDACTED}") instead of the real one, so nothing was sent.`,
    {
      hint: 'Values marked redact are saved masked when a run pauses. Run the playbook again; if this step fails the same way, ask its owner to use the input directly in this step.',
    },
  );

export class Engine {
  readonly limits: Limits;
  readonly clock: Clock;
  private readonly handlers: StepHandlerRegistry;
  private readonly notifier: Notifier;

  constructor(readonly opts: EngineOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.clock = opts.clock ?? systemClock;
    this.handlers = { ...builtinHandlers, ...opts.handlers };
    this.notifier = opts.notifier ?? createGraphNotifier(opts.outbound);
  }

  /** Runs `runId` (whose definition is `def`, pinned by the caller) until it finishes or parks. */
  async execute(runId: string, def: AutomationDefinition, opts: ExecuteOptions = {}): Promise<RunOutcome> {
    const run = await this.opts.store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (isTerminal(run.status)) return { status: run.status, outputs: run.outputs, error: run.error };
    const records = await this.opts.store.listSteps(runId);
    const exec = new Execution(this, this.handlers, this.notifier, run, def, records, opts);
    return exec.start();
  }
}

export const createEngine = (opts: EngineOptions) => new Engine(opts);

class Execution {
  private readonly store: RunStore;
  private readonly clock: Clock;
  private readonly limits: Limits;
  private readonly records = new Map<string, StepRecord>();
  private seq = 1;
  private readonly ac = new AbortController();
  /** A graceful stop: no new step starts (ExecuteOptions.interrupt). */
  private readonly interrupt: AbortSignal | undefined;
  private readonly dryRun: boolean;
  private readonly byId = new Map<string, Step>();
  private lastCancelCheck = 0;
  private top!: Frame;
  private readonly depth: number;
  /**
   * Values of inputs declared `redact: true` (run inputs, and manual-step values as they arrive): masked wherever they
   * would be stored or emitted.
   */
  private readonly secrets: string[];
  /**
   * Paths whose record came from the store (an earlier pass of this run). Stored records are masked, so when the run
   * has secrets their outputs may hold `[redacted]` instead of the real value (see `restoreView`).
   */
  private readonly restored = new Set<string>();
  /**
   * Paths of reads, transforms and asserts an earlier pass ran after the last write sent in their scope: run again
   * before this pass sends a write (see `recheck`). Empty on a first pass and in dry runs.
   */
  private readonly stale = new Set<string>();
  /** Highest attempt number recorded per path (a step run again continues the count). */
  private readonly attempts = new Map<string, number>();
  /** Attempts of an earlier re-check left in flight (a restart): closed at start, the finished record before stands. */
  private readonly dangling: StepRecord[] = [];
  private recheckOrder = 0;

  constructor(
    private readonly engine: Engine,
    private readonly handlers: StepHandlerRegistry,
    private readonly notifier: Notifier,
    private run: RunRecord,
    private readonly def: AutomationDefinition,
    records: StepRecord[],
    opts: ExecuteOptions,
  ) {
    // After a lost lock this worker writes nothing more — another worker may be driving the run now (D-01).
    const store = engine.opts.store;
    const owned = () => !this.disowned();
    this.store = {
      getRun: (id) => store.getRun(id),
      listSteps: (id) => store.listSteps(id),
      getDecision: (id, path) => store.getDecision(id, path),
      updateRun: async (id, patch, expect) => (owned() ? store.updateRun(id, patch, expect) : null),
      saveStep: async (id, record, meta) => {
        if (owned()) await store.saveStep(id, record, meta);
      },
      appendEvent: async (id, event) => {
        if (owned()) await store.appendEvent(id, event);
      },
      openTask: async (id, task) => {
        if (owned()) await store.openTask(id, task);
      },
    };
    this.clock = engine.clock;
    this.limits = engine.limits;
    this.dryRun = run.dryRun;
    this.depth = opts.depth ?? 0;
    this.secrets = secretInputValues(def.inputs, run.inputs ?? {});
    const sorted = [...records].sort((a, b) => a.seq - b.seq);
    for (const r of sorted) {
      this.records.set(r.path, r);
      this.restored.add(r.path);
      this.seq = Math.max(this.seq, r.seq + 1);
      this.attempts.set(r.path, Math.max(this.attempts.get(r.path) ?? 0, r.attempt));
    }
    for (const s of allSteps(def)) this.byId.set(s.id, s);
    if (!this.dryRun) this.findStale(sorted);
    // The reason travels with the abort: an interrupt (shutdown, lost lock) is not a cancel.
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) this.ac.abort(signal.reason);
      else signal.addEventListener('abort', () => this.ac.abort(signal.reason), { once: true });
    }
    this.interrupt = opts.interrupt;
  }

  // ───────────────────────────── stopping ─────────────────────────────

  /** Why the run must stop now, resumable: an interrupt on the signal, else a graceful stop; null otherwise. */
  private interruption(): RunInterrupted | null {
    const hard = RunInterrupted.from(this.ac.signal);
    if (hard) return hard;
    if (!this.interrupt?.aborted) return null;
    return RunInterrupted.from(this.interrupt) ?? new RunInterrupted('shutdown');
  }

  /** The flow when the signal aborted: interrupted (resumable) for an interrupt, cancelled for anything else. */
  private stopped(): Flow {
    const why = RunInterrupted.from(this.ac.signal);
    return why ? { kind: 'interrupted', why } : { kind: 'cancelled' };
  }

  /** After a lost lock this worker no longer owns the run: it records nothing more (another worker drives it). */
  private disowned(): RunInterrupted | null {
    const why = RunInterrupted.from(this.ac.signal);
    return why && !why.owned ? why : null;
  }

  /**
   * Interrupted: the run and the step in flight are left as they are (`running`), so the next worker continues from
   * the last checkpoint. On a shutdown the run's log says so; after a lost lock nothing is written.
   */
  private async pause(why: RunInterrupted): Promise<RunOutcome> {
    if (why.owned)
      await this.emit(null, { type: 'log', level: 'info', data: { message: why.message } }).catch(
        () => undefined,
      );
    return { status: this.run.status };
  }

  // ───────────────────────────── run lifecycle ─────────────────────────────

  async start(): Promise<RunOutcome> {
    const startedAt = this.run.startedAt ?? this.clock.now();
    const was = this.run.status;
    const updated = await this.store.updateRun(this.run.id, { status: 'running', startedAt }, NON_TERMINAL);
    if (!updated) return this.current();
    this.run = updated;
    if (was !== 'running') await this.runEvent('running');
    this.top = { prefix: '', actor: this.run.initiator, locals: new Map(), parent: null, vars: {} };
    await this.closeDangling();

    const tooBig = checkDefinition(this.def, this.limits);
    if (tooBig)
      return this.finish({
        kind: 'fail',
        error: { code: 'limit_exceeded', message: tooBig },
        policy: 'fail',
      });

    if (this.run.error?.compensating) return this.finishCompensation(this.run.error);
    let flow: Flow;
    try {
      flow = await this.runSteps(this.topSteps(), this.top);
    } catch (err) {
      const why = RunInterrupted.from(err);
      if (why) flow = { kind: 'interrupted', why };
      else if (err instanceof RunCancelled || this.ac.signal.aborted) flow = this.stopped();
      else throw err;
    }
    return this.finish(flow);
  }

  private async current(): Promise<RunOutcome> {
    const r = await this.store.getRun(this.run.id);
    return { status: r?.status ?? this.run.status, outputs: r?.outputs ?? null, error: r?.error ?? null };
  }

  /** Top-level steps, with the implicit approval gate of `approval: { required: true }` definitions inserted. */
  private topSteps(): Step[] {
    const steps = [...flattenSteps(this.def)];
    const at = implicitApprovalIndex(this.def);
    if (at >= 0) {
      const a = this.def.approval!;
      const gate = {
        id: IMPLICIT_APPROVAL,
        type: 'approval',
        name: 'Approval',
        message: `Approve ${this.def.title}`,
        ...(a.approvers ? { approvers: a.approvers } : {}),
        ...(a.minApprovals ? { minApprovals: a.minApprovals } : {}),
        ...(a.expiresIn ? { expiresIn: a.expiresIn } : {}),
        ...(a.excludes ? { excludes: a.excludes } : {}),
      } as ApprovalStep;
      steps.splice(at, 0, gate);
    }
    return steps;
  }

  private async finish(flow: Flow): Promise<RunOutcome> {
    switch (flow.kind) {
      case 'ok': {
        let outputs: Record<string, unknown> | null = null;
        if (this.def.outputs) {
          try {
            outputs = await renderTemplate<Record<string, unknown>>(this.def.outputs, this.scope(this.top));
          } catch (err) {
            outputs = { $error: (err as Error).message };
          }
        }
        return this.end('succeeded', { outputs, error: null });
      }
      case 'park': {
        if (flow.status === 'running')
          return { status: 'running', ...(flow.wakeAt ? { wakeAt: flow.wakeAt } : {}) };
        const r = await this.store.updateRun(this.run.id, { status: flow.status }, ['running']);
        if (!r) return this.current();
        this.run = r;
        await this.runEvent(flow.status);
        return { status: flow.status };
      }
      case 'cancelled':
        return this.end('cancelled', {});
      case 'interrupted':
        return this.pause(flow.why);
      case 'fail':
        if (flow.needsReview) return this.end('needs_review', { error: flow.error });
        if (flow.policy === 'compensate') return this.finishCompensation(flow.error);
        return this.end('failed', { error: flow.error });
    }
  }

  private async end(
    status: RunStatus,
    patch: { outputs?: Record<string, unknown> | null; error?: RunError | null },
  ): Promise<RunOutcome> {
    const from = status === 'cancelled' ? NON_TERMINAL : (['running'] as const);
    // Run outputs and errors are stored and shown: values of `redact: true` inputs never reach them.
    const masked = {
      ...('outputs' in patch ? { outputs: this.mask(patch.outputs) } : {}),
      ...('error' in patch ? { error: this.mask(patch.error) } : {}),
    };
    const r = await this.store.updateRun(this.run.id, { status, endedAt: this.clock.now(), ...masked }, from);
    if (!r) return this.current();
    this.run = r;
    await this.runEvent(status, patch.error ?? undefined);
    return { status, outputs: r.outputs, error: r.error };
  }

  private async runEvent(status: RunStatus, error?: RunError, extra: Record<string, unknown> = {}) {
    await this.store.appendEvent(this.run.id, {
      type: 'status',
      data: { scope: 'run', status, ...(error ? { error: this.mask(error) } : {}), ...extra },
    });
  }

  private addSecrets(values: readonly string[]) {
    for (const v of values) if (!this.secrets.includes(v)) this.secrets.push(v);
  }

  /** A copy with the run's secret values (and credential-named keys) masked — for anything stored or emitted. */
  private mask<T>(v: T): T {
    return this.secrets.length && v != null ? (redact(v, this.secrets) as T) : v;
  }

  // ───────────────────────────── scope & frames ─────────────────────────────

  private views(frame: Frame): Record<string, View> {
    const chain: Frame[] = [];
    for (let f: Frame | null = frame; f; f = f.parent) chain.unshift(f);
    const out: Record<string, View> = {};
    for (const f of chain) for (const [k, v] of f.locals) out[k] = v;
    return out;
  }

  private vars(frame: Frame): Record<string, unknown> {
    const chain: Frame[] = [];
    for (let f: Frame | null = frame; f; f = f.parent) chain.unshift(f);
    return Object.assign({}, ...chain.map((f) => f.vars)) as Record<string, unknown>;
  }

  private scope(frame: Frame): Scope {
    const actor = frame.actor;
    return {
      inputs: this.run.inputs,
      steps: this.views(frame),
      run: {
        id: this.run.id,
        dryRun: this.dryRun,
        trigger: this.run.trigger,
        correlationId: this.run.correlationId,
        definition: { key: this.run.definitionKey, version: this.run.definitionVersion },
        initiator: { oid: this.run.initiator.oid, upn: this.run.initiator.upn },
        startedAt: this.run.startedAt ? iso(this.run.startedAt) : null,
      },
      user: {
        kind: actor.kind,
        oid: actor.oid,
        upn: actor.upn,
        roles: this.engine.opts.rolesOf?.(actor, this.run) ?? [],
      },
      env: this.engine.opts.env ?? {},
      now: iso(this.clock.now()),
      ...this.vars(frame),
    };
  }

  private render<T = unknown>(value: unknown, frame: Frame): Promise<T> {
    return renderTemplate<T>(value, this.scope(frame));
  }

  private setView(frame: Frame, id: string, view: View) {
    frame.locals.set(id, view);
  }

  /** A step as expressions see it. No output (null/undefined) is *missing*, so `$exists(steps.x.output)` is false — the same before and after a resume (storage keeps null). */
  private viewOf(rec: StepRecord): View {
    return { output: rec.output === null ? undefined : rec.output, status: rec.status, error: rec.error };
  }

  /** Whether a record was read back from the store with masked values in it (only when the run has secrets). */
  private maskedRecord(rec: StepRecord, value: unknown): boolean {
    return this.secrets.length > 0 && this.restored.has(rec.path) && containsRedacted(value);
  }

  /**
   * The view of a finished step reused after a pause. Stored records are masked, so a pure step (transform, assert)
   * whose output held a secret would hand later steps the literal `[redacted]`: it is computed again from the run's
   * real inputs instead — and used only when, masked, it equals what was stored (the same result, not a new one).
   * Outputs of steps that called a service can't be recomputed; sending them on is refused (see `attempt`).
   */
  private async restoreView(
    step: Step,
    handler: StepHandler,
    rec: StepRecord,
    frame: Frame,
    path: string,
    mode: Mode,
  ): Promise<View> {
    const stored = this.viewOf(rec);
    if (handler.external || rec.status !== 'succeeded' || !this.maskedRecord(rec, rec.output)) return stored;
    let fresh: unknown;
    const intercepted = this.engine.opts.intercept?.({ id: step.id, type: step.type, mode }, path, {
      dryRun: this.dryRun,
      runId: this.run.id,
      compensation: false,
    });
    try {
      if (intercepted) {
        if (!('output' in intercepted)) return stored;
        fresh = intercepted.output;
      } else {
        const ctx = {
          ...this.context(step.id, path, mode, frame, this.ac.signal, { seq: null }),
          emit: async () => undefined,
        };
        const res = await handler.execute(await handler.prepare(step as never, ctx), ctx);
        if (res.error || res.park) return stored;
        fresh = res.output ?? null;
      }
    } catch {
      return stored;
    }
    fresh =
      extractSecrets(fresh ?? null, secretSpec(step as { secret?: boolean; secretOutputs?: string[] }))
        .masked ?? null;
    const same =
      JSON.stringify(storableOutput(this.mask(fresh), this.limits.maxOutputBytes)) ===
      JSON.stringify(rec.output);
    if (!same) return stored;
    // In memory only (compensations render against it); saving the record masks it again.
    rec.output = fresh;
    return this.viewOf(rec);
  }

  // ───────────────────────────── records & events ─────────────────────────────

  private newRecord(
    stepId: string,
    type: string,
    path: string,
    mode: Mode,
    actor: Actor | null,
    partial: Partial<StepRecord> = {},
  ): StepRecord {
    return {
      seq: this.seq++,
      stepId,
      path,
      type,
      attempt: 1,
      status: 'running',
      actorOid: actor?.oid ?? null,
      mode,
      request: null,
      plan: null,
      output: null,
      error: null,
      msRequestId: null,
      startedAt: this.clock.now(),
      endedAt: null,
      ...partial,
    };
  }

  private async save(rec: StepRecord, actor: Actor | null) {
    this.records.set(rec.path, rec);
    this.restored.delete(rec.path);
    // Redacted copy for the store (and from there the run view and audit); the in-memory record keeps real values.
    const stored: StepRecord = {
      ...rec,
      request: this.mask(rec.request),
      plan: this.mask(rec.plan),
      error: this.mask(rec.error),
      output: storableOutput(this.mask(rec.output), this.limits.maxOutputBytes),
    };
    await this.store.saveStep(this.run.id, stored, { actor, dryRun: this.dryRun });
    await this.store.appendEvent(this.run.id, {
      type: 'status',
      stepSeq: rec.seq,
      data: {
        scope: 'step',
        path: rec.path,
        stepId: rec.stepId,
        type: rec.type,
        status: rec.status,
        attempt: rec.attempt,
        ...(stored.error ? { error: stored.error } : {}),
      },
    });
  }

  private async emit(seq: number | null, event: Omit<RunEventInput, 'stepSeq'>) {
    const data = this.secrets.length && event.data != null ? redact(event.data, this.secrets) : event.data;
    await this.store.appendEvent(this.run.id, { ...event, data, stepSeq: seq } as RunEventInput);
  }

  private async close(rec: StepRecord, actor: Actor | null, patch: Partial<StepRecord>) {
    Object.assign(rec, { endedAt: this.clock.now() }, patch);
    await this.save(rec, actor);
  }

  // ───────────────────────────── checks ─────────────────────────────

  private humanWaitMs(): number {
    const now = this.clock.now().getTime();
    let total = 0;
    for (const r of this.records.values()) {
      if ((r.type !== 'approval' && r.type !== 'manual') || !r.startedAt) continue;
      total +=
        (r.endedAt ?? (r.status === 'waiting' ? new Date(now) : r.startedAt)).getTime() -
        r.startedAt.getTime();
    }
    return total;
  }

  private remainingMs(): number {
    const started = (this.run.startedAt ?? this.clock.now()).getTime();
    return this.limits.maxRunMs - (this.clock.now().getTime() - started - this.humanWaitMs());
  }

  /** Before each step: cancellation (signal or stored status), an interrupt, and the run time limit. */
  private async checkpoint(): Promise<Flow | null> {
    if (this.ac.signal.aborted) return this.stopped();
    const now = this.clock.now().getTime();
    if (now - this.lastCancelCheck >= CANCEL_CHECK_MS || this.lastCancelCheck === 0) {
      this.lastCancelCheck = now;
      const r = await this.store.getRun(this.run.id);
      if (r?.status === 'cancelled') {
        this.ac.abort();
        return { kind: 'cancelled' };
      }
    }
    const why = this.interruption();
    if (why) return { kind: 'interrupted', why };
    if (this.remainingMs() <= 0) {
      return {
        kind: 'fail',
        policy: 'fail',
        error: {
          code: 'run_timeout',
          message: `The run exceeded its time limit of ${Math.round(this.limits.maxRunMs / 60_000)} minutes.`,
        },
      };
    }
    return null;
  }

  // ───────────────────────────── checking again on resume ─────────────────────────────

  /**
   * A run that paused (an approval, input, write access, a sign-in, a `wait`, a restart) reads and checks again before
   * it writes. A pass that continues an earlier one runs again, right before it sends its next write, the reads,
   * transforms and asserts the earlier pass ran since the last write sent in their scope — as the person the write runs
   * as — so a guard such as "the session still belongs to the person the list showed" holds now, not when the run
   * paused. A step that fails now fails like the first time (its `onError` applies: by default the run ends `failed`
   * with the assert's message) and the write is not sent.
   *
   * What the run decided stays as recorded: approvals and input, `when`, branch arms and forEach items. Writes already
   * sent are never sent again, and what was read before them is not read again. Steps with show-once secrets and child
   * playbooks (which check for themselves) are not run again. Scope: a step inside a forEach iteration guards that
   * iteration's writes, a step outside guards every write after it; a finished forEach before the write is walked
   * again with its items as recorded, so its reads run again and its output is rebuilt.
   */
  private findStale(sorted: readonly StepRecord[]) {
    // A re-check attempt that never finished (a restart, a sign-in needed mid-call) leaves the finished record before
    // it in force: that step is still due to run again.
    const finished = new Map<string, StepRecord>();
    for (const r of sorted) if (r.status === 'succeeded' || r.status === 'failed') finished.set(r.path, r);
    for (const [path, rec] of this.records) {
      const before = finished.get(path);
      if (!before || before === rec || !this.recheckable(before)) continue;
      if (rec.status === 'running') this.dangling.push(rec);
      this.records.set(path, before);
    }
    // Writes sent, in seq order: a step is covered by one sent after it that could build on it.
    const sent = [...this.records.values()]
      .filter((r) => this.wasSent(r))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, frames: framesOf(r.path) }));
    for (const [path, rec] of this.records) {
      if ((rec.status !== 'succeeded' && rec.status !== 'failed') || !this.recheckable(rec)) continue;
      const frames = framesOf(path);
      let lo = 0;
      for (let hi = sent.length; lo < hi;) {
        const mid = (lo + hi) >> 1;
        if (sent[mid]!.seq > rec.seq) hi = mid;
        else lo = mid + 1;
      }
      let covered = false;
      for (let i = lo; i < sent.length && !covered; i++) covered = sameStrand(frames, sent[i]!.frames);
      if (!covered) this.stale.add(path);
    }
  }

  /** What a re-check runs again: reads, transforms and asserts (not show-once secrets, not child playbooks). */
  private recheckable(rec: StepRecord): boolean {
    const step = this.byId.get(rec.stepId);
    return !!step && !rec.path.includes('#') && this.rerunnable(step);
  }

  /** A read, transform or assert that is safe to run twice (not `idempotent: false`, no show-once secrets). */
  private rerunnable(step: Step): boolean {
    if (CONTROL.has(step.type) || stepMode(step) !== 'read') return false;
    if (step.secret || step.secretOutputs || step.idempotent === false) return false;
    const handler = this.handlers[step.type];
    return !!handler && !handler.plansItself;
  }

  /** A write that was sent (or may have been), or a child playbook that started: what came before it stays. */
  private wasSent(rec: StepRecord): boolean {
    if (rec.mode !== 'write' || rec.path.includes('#')) return false;
    if (SENT.includes(rec.status)) return true;
    return this.handlers[rec.type]?.plansItself === true && !['skipped', 'cancelled'].includes(rec.status);
  }

  /** Closes the re-check attempts a stop left in flight; the record before each stands (see `findStale`). */
  private async closeDangling() {
    for (const rec of this.dangling.splice(0))
      await this.store.saveStep(
        this.run.id,
        {
          ...rec,
          status: 'retried',
          endedAt: this.clock.now(),
          error: {
            code: 'interrupted',
            message: 'The worker stopped while this attempt was in flight.',
            stepId: rec.stepId,
            path: rec.path,
          },
        },
        { actor: null, dryRun: this.dryRun },
      );
  }

  /** The frame a re-check runs in: `frame`'s steps and loop variables, as `actor`, reads with `callAs`'s access. */
  private recheckFrame(frame: Frame, actor: Actor, callAs: Actor): Frame {
    const { prefix, locals, parent, vars } = frame;
    return { prefix, actor, callAs, locals, parent, vars, recheck: true };
  }

  /** Whether a re-check is pending around `frame` (this pass reused something stale that no write covered yet). */
  private chainPending(frame: Frame): boolean {
    for (let f: Frame | null = frame; f; f = f.parent) if (this.pendingRechecks(f)) return true;
    return false;
  }

  /** Whether a frame still holds something to run again (a write in it hasn't covered it yet). */
  private pendingRechecks(frame: Frame): boolean {
    return (frame.rechecks ?? []).some((u) => !u.done);
  }

  /**
   * Notes a stale step this pass reused — or one it ran fresh while a re-check is pending around it (it may have read
   * what is stale: a check after an approval on what was read before it) — to run again before the next write in its
   * scope, as who it ran as.
   */
  private keepForRecheck(step: Step, frame: Frame, path: string, fresh = false) {
    if (frame.recheck) return;
    if (fresh) {
      if (this.dryRun || !this.rerunnable(step) || !this.chainPending(frame)) return;
      this.stale.add(path);
    } else if (!this.stale.has(path)) return;
    const asWalked = { ...frame.actor };
    (frame.rechecks ??= []).push({
      order: this.recheckOrder++,
      run: (callAs) => this.runLeaf(step, this.recheckFrame(frame, asWalked, callAs)),
    });
  }

  /**
   * Before a write is sent: runs again, in walk order and as the person the write runs as, what this pass reused from
   * an earlier one in the write's scope (its frame and the frames around it). Returns the flow to stop with when one of
   * them now fails, else whether anything was checked again (the write is then built and authorised anew). A sign-in
   * that a step needs is thrown, and the write parks on it.
   */
  private async recheck(frame: Frame, path: string): Promise<Flow | boolean> {
    const units: Recheck[] = [];
    for (let f: Frame | null = frame; f; f = f.parent) units.push(...(f.rechecks ?? []));
    if (!units.length) return false;
    units.sort((a, b) => a.order - b.order);
    if (units.some((u) => !u.done))
      await this.emit(null, {
        type: 'log',
        level: 'info',
        data: {
          message: 'The run paused before this change, so what it read and checked runs again first.',
          path,
        },
      });
    for (const u of units) {
      u.done ??= u.run(frame.actor);
      const flow = await u.done;
      if (flow.kind !== 'ok') return flow;
    }
    return true;
  }

  /** A stale step run again: a new attempt (its `when` isn't evaluated again — it ran). */
  private async rerun(
    step: Step,
    frame: Frame,
    handler: StepHandler,
    path: string,
    mode: Mode,
  ): Promise<Flow> {
    this.stale.delete(path);
    const before = this.records.get(path);
    // `/me` read with someone else's access is someone else: what it read for the person it ran as stands.
    if (frame.callAs && frame.callAs.oid !== frame.actor.oid && readsMe(step) && before) {
      this.setView(frame, step.id, this.viewOf(before));
      return OK;
    }
    const outcome = await this.attempt({
      stepId: step.id,
      type: step.type,
      path,
      mode,
      handler,
      body: step,
      retry: step.retry,
      timeout: step.timeout,
      frame,
      describe: step.describe,
      dryRunOutput: step.dryRunOutput,
      existing: undefined,
      firstAttempt: Math.max(this.attempts.get(path) ?? 0, before?.attempt ?? 0) + 1,
    });
    if (outcome.kind === 'flow') return outcome.flow;
    this.setView(frame, step.id, this.viewOf(outcome.rec));
    if (outcome.kind === 'ok') return OK;
    const error = outcome.rec.error!;
    return this.policy(step, error.hint ? error : { ...error, hint: RECHECK_HINT });
  }

  /** In a re-check only what already ran is walked: nothing new starts, nothing waits, no write is sent. */
  private rewalks(step: Step, frame: Frame): boolean {
    const rec = this.records.get(frame.prefix + step.id);
    if (!rec) return false;
    if (step.type === 'branch' || step.type === 'forEach') return true;
    return REUSABLE.includes(rec.status);
  }

  // ───────────────────────────── step walk ─────────────────────────────

  private async runSteps(steps: readonly Step[], frame: Frame): Promise<Flow> {
    for (const step of steps) {
      const pre = await this.checkpoint();
      if (pre) return pre;
      const flow = await this.runStep(step, frame);
      if (flow.kind !== 'ok') return flow;
    }
    return OK;
  }

  private runStep(step: Step, frame: Frame): Promise<Flow> {
    if (frame.recheck && !this.rewalks(step, frame)) return Promise.resolve(OK);
    switch (step.type) {
      case 'branch':
        return this.runBranch(step, frame);
      case 'forEach':
        return this.runForEach(step, frame);
      case 'approval':
        return this.runApproval(step, frame);
      case 'manual':
        return this.runManual(step, frame);
      case 'wait':
        return this.runWait(step, frame);
      default:
        return this.runLeaf(step, frame);
    }
  }

  /** `onError` of a failed step: continue → carry on; compensate/fail → propagate. */
  private policy(step: Step, error: RunError): Flow {
    const onError = step.onError ?? 'fail';
    if (onError === 'continue') return OK;
    return { kind: 'fail', error, policy: onError };
  }

  private async evalWhen(step: Step, frame: Frame): Promise<{ skip: boolean } | { error: RunError }> {
    if (step.when === undefined) return { skip: false };
    try {
      const v = typeof step.when === 'boolean' ? step.when : await this.render(step.when, frame);
      return { skip: !truthy(v) };
    } catch (err) {
      return { error: toRunError(err, { stepId: step.id, path: frame.prefix + step.id }) };
    }
  }

  /** Common prelude for every step: reuse a finished record, honour `when`. Returns a Flow when the step is done. */
  private async prelude(
    step: Step,
    frame: Frame,
    mode: Mode,
  ): Promise<{ done: Flow } | { rec: StepRecord | undefined }> {
    const path = frame.prefix + step.id;
    const rec = this.records.get(path);
    if (rec && (rec.status === 'skipped' || (rec.status === 'failed' && !CONTROL.has(step.type)))) {
      this.setView(frame, step.id, this.viewOf(rec));
      return { done: OK };
    }
    if (rec) return { rec };
    const w = await this.evalWhen(step, frame);
    if ('error' in w) {
      const failed = this.newRecord(step.id, step.type, path, mode, frame.actor, {
        status: 'failed',
        error: w.error,
        endedAt: this.clock.now(),
      });
      await this.save(failed, frame.actor);
      this.setView(frame, step.id, this.viewOf(failed));
      return { done: this.policy(step, w.error) };
    }
    if (w.skip) {
      const skipped = this.newRecord(step.id, step.type, path, mode, frame.actor, {
        status: 'skipped',
        endedAt: this.clock.now(),
      });
      await this.save(skipped, frame.actor);
      this.setView(frame, step.id, this.viewOf(skipped));
      return { done: OK };
    }
    return { rec: undefined };
  }

  private context(
    stepId: string,
    path: string,
    mode: Mode,
    frame: Frame,
    signal: AbortSignal,
    seqRef: { seq: number | null },
    spec: SecretSpec | null = null,
  ): StepContext {
    return {
      run: this.run,
      stepId,
      path,
      mode,
      dryRun: this.dryRun,
      depth: this.depth,
      actor: frame.actor,
      identity: null,
      scope: this.scope(frame),
      render: (value) => this.render(value, frame),
      signal,
      correlationId: this.run.correlationId,
      ports: {
        outbound: this.engine.opts.outbound,
        notifier: this.notifier,
        ...(this.engine.opts.runner ? { runner: this.engine.opts.runner } : {}),
        ...(this.engine.opts.children ? { children: this.engine.opts.children } : {}),
      },
      limits: this.limits,
      // Streamed outputs (runner) of a secret step are masked like the step output.
      emit: (e) =>
        this.emit(
          seqRef.seq,
          spec && e.type === 'output'
            ? { ...e, data: { ...e.data, data: extractSecrets(e.data.data, spec).masked } }
            : e,
        ),
    };
  }

  /**
   * Masks a step's show-once secrets and hands the values to the SecretSink (never to the store). A failed hand-off
   * does not fail the step — the write already happened — but is recorded (without the value).
   */
  private async secure(
    output: unknown,
    spec: SecretSpec | null,
    at: { stepId: string; path: string; seq: number; frame: Frame; deliver: boolean },
  ): Promise<unknown> {
    const { masked, values, hints } = extractSecrets(output, spec);
    const fields = Object.keys(values);
    if (!fields.length || !at.deliver) return masked;
    let outcome: Awaited<ReturnType<SecretSink['deliver']>> = {
      status: 'discarded',
      reason: 'No secret channel is configured.',
    };
    if (this.engine.opts.secrets) {
      try {
        outcome = await this.engine.opts.secrets.deliver(this.run, {
          runId: this.run.id,
          stepId: at.stepId,
          stepPath: at.path,
          values,
          hints,
          producedBy: at.frame.actor,
          producedAt: iso(this.clock.now()),
        });
      } catch (err) {
        outcome = { status: 'discarded', reason: (err as Error).message };
      }
    }
    const message =
      outcome.status === 'discarded'
        ? `A secret output could not be delivered and was discarded${outcome.reason ? `: ${outcome.reason}` : '.'}`
        : 'Secret output ready. It is shown once to the person who started the run and is not stored.';
    await this.emit(at.seq, {
      type: 'log',
      level: outcome.status === 'discarded' ? 'warn' : 'info',
      data: {
        message,
        path: at.path,
        secret: {
          runId: this.run.id,
          stepId: at.stepId,
          stepPath: at.path,
          fields,
          hints,
          status: outcome.status,
        },
      },
    });
    return masked;
  }

  /**
   * A templated text shown to people. `markdown`: the text is rendered as Markdown (approval messages, manual-step
   * instructions), so the values its expressions produce are escaped and can never become links or markup.
   */
  private async describe(
    text: string | undefined,
    frame: Frame,
    opts: { markdown?: boolean } = {},
  ): Promise<string | null> {
    if (!text) return null;
    try {
      if (opts.markdown) return await renderMarkdown(text, this.scope(frame));
      const v = await this.render(text, frame);
      return v === undefined || v === null ? null : String(v);
    } catch {
      return text;
    }
  }

  // ───────────────────────────── leaf steps ─────────────────────────────

  private async runLeaf(step: Step, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const mode = stepMode(step);
    const handler = this.handlers[step.type];
    if (frame.recheck && handler && this.stale.has(path)) return this.rerun(step, frame, handler, path, mode);
    const pre = await this.prelude(step, frame, mode);
    if ('done' in pre) {
      this.keepForRecheck(step, frame, path);
      return pre.done;
    }
    const rec = pre.rec;
    if (!handler) {
      const error: RunError = {
        code: 'unknown_step_type',
        message: `No handler for step type ${step.type}.`,
        stepId: step.id,
        path,
      };
      await this.save(
        this.newRecord(step.id, step.type, path, mode, frame.actor, {
          status: 'failed',
          error,
          endedAt: this.clock.now(),
        }),
        frame.actor,
      );
      return this.policy(step, error);
    }
    if (rec) {
      if (REUSABLE.includes(rec.status)) {
        this.setView(frame, step.id, await this.restoreView(step, handler, rec, frame, path, mode));
        this.keepForRecheck(step, frame, path);
        return OK;
      }
      if (rec.status === 'running') {
        if (step.idempotent === false) {
          const error: RunError = {
            code: 'needs_review',
            message: `Step ${step.id} was in flight when the worker stopped. It is not idempotent, so it was not retried — check whether it took effect.`,
            stepId: step.id,
            path,
          };
          await this.close(rec, frame.actor, { status: 'needs_review', error });
          return { kind: 'fail', error, policy: 'fail', needsReview: true };
        }
        await this.close(rec, frame.actor, {
          status: 'retried',
          error: {
            code: 'interrupted',
            message: 'The worker stopped while this attempt was in flight.',
            stepId: step.id,
            path,
          },
        });
      }
    }

    const outcome = await this.attempt({
      stepId: step.id,
      type: step.type,
      path,
      mode,
      handler,
      body: step,
      retry: step.retry,
      timeout: step.timeout,
      frame,
      describe: step.describe,
      dryRunOutput: step.dryRunOutput,
      existing: rec && (rec.status === 'waiting' || rec.status === 'retried') ? rec : undefined,
      ...(mode === 'write' && handler.external && !this.dryRun && !frame.recheck
        ? { beforeSend: () => this.recheck(frame, path) }
        : {}),
    });
    if (outcome.kind === 'ok') {
      this.setView(frame, step.id, this.viewOf(outcome.rec));
      this.keepForRecheck(step, frame, path, true);
      return OK;
    }
    if (outcome.kind === 'failed') {
      this.setView(frame, step.id, this.viewOf(outcome.rec));
      this.keepForRecheck(step, frame, path, true);
      return this.policy(step, outcome.rec.error!);
    }
    return outcome.flow;
  }

  /**
   * Prepare → (plan | resolve identity → execute with retries and timeout). Shared by leaf steps and compensations.
   * `existing` is a `waiting` record to reuse (identity park) or a `retried` one to continue from.
   */
  private async attempt(a: {
    stepId: string;
    type: string;
    path: string;
    mode: Mode;
    handler: StepHandler;
    body: Step | Compensation;
    retry: RetryPolicy | undefined;
    timeout: string | undefined;
    frame: Frame;
    describe: string | undefined;
    dryRunOutput: unknown;
    existing: StepRecord | undefined;
    compensation?: boolean;
    /** Attempt number of a new record (a step run again continues its count). Default 1. */
    firstAttempt?: number;
    /** Once the identity is resolved, before the first send: re-checks on resume (see `recheck`). */
    beforeSend?: () => Promise<Flow | boolean>;
  }): Promise<
    { kind: 'ok'; rec: StepRecord } | { kind: 'failed'; rec: StepRecord } | { kind: 'flow'; flow: Flow }
  > {
    const { frame, handler, path, mode } = a;
    // Who the step goes out as: in a re-check, the person the guarded write runs as (see `recheck`).
    const caller = frame.callAs ?? frame.actor;
    const seqRef: { seq: number | null } = { seq: null };
    const spec = a.compensation ? null : secretSpec(a.body as { secret?: boolean; secretOutputs?: string[] });
    const fail = async (err: unknown, rec?: StepRecord) => {
      const error = toRunError(err, { stepId: a.stepId, path });
      const r =
        rec ??
        this.newRecord(a.stepId, a.type, path, mode, caller, {
          attempt: a.existing
            ? a.existing.attempt + (a.existing.status === 'retried' ? 1 : 0)
            : (a.firstAttempt ?? 1),
        });
      await this.close(r, caller, { status: 'failed', error });
      return { kind: 'failed' as const, rec: r };
    };

    let prep: Prepared;
    try {
      prep = await handler.prepare(
        a.body as never,
        this.context(a.stepId, path, mode, frame, this.ac.signal, seqRef),
      );
    } catch (err) {
      return fail(err);
    }
    const intercepted = this.engine.opts.intercept?.({ id: a.stepId, type: a.type, mode }, path, {
      dryRun: this.dryRun,
      runId: this.run.id,
      compensation: a.compensation === true,
    });
    const describe = await this.describe(a.describe, frame);

    // Dry run: writes become plan entries. A write child playbook is planned as one entry and, when children are
    // dry-run too (default with a ChildRunner), followed by the child's own entries.
    const planned = this.dryRun && mode === 'write' && handler.external;
    const entry: PlanEntry = {
      stepId: a.stepId,
      stepPath: path,
      describe,
      ...(prep.plan ?? { service: a.type, method: 'WRITE' }),
      ...(a.compensation ? { compensation: true } : {}),
    };
    const delegate =
      handler.plansItself === true &&
      !!this.engine.opts.children &&
      (this.engine.opts.dryRunChildren ?? true);
    // A mocked child playbook (content tests) counts as a child that ran: its own tests cover its plan.
    const mockedChild = handler.plansItself === true && !!intercepted && 'output' in intercepted;
    const planSelf = planned && !mockedChild;
    if (planSelf && (!delegate || intercepted)) {
      const rec = this.newRecord(a.stepId, a.type, path, mode, caller, {
        request: prep.request,
        plan: [entry],
        ...(a.existing ? { seq: a.existing.seq } : {}),
      });
      if (intercepted && 'error' in intercepted) return fail(intercepted.error, rec);
      let output: unknown;
      try {
        output =
          intercepted && 'output' in intercepted
            ? intercepted.output
            : a.dryRunOutput !== undefined
              ? await this.render(a.dryRunOutput, frame)
              : null;
      } catch (err) {
        return fail(err, rec);
      }
      // Dry runs produce no real secrets: mask whatever dryRunOutput/mocks say, deliver nothing.
      await this.close(rec, caller, {
        status: 'planned',
        output: extractSecrets(output ?? null, spec).masked ?? null,
      });
      return { kind: 'ok', rec };
    }

    // A value masked when the run was saved must never be sent as if it were data (e.g. set as a password after the run
    // paused for an approval). Refuse the step rather than send the placeholder. (Child playbooks check their inputs
    // when the child run is created — a resumed child already has its own.)
    if (handler.external && !handler.plansItself && !intercepted && containsRedacted(prep.payload))
      return fail(redactedValueError());

    // Identity for external steps (write steps refuse to run unless the actor is armed). Child playbooks resolve their own.
    const resolveIdentity = async (): Promise<
      { identity: ResolvedIdentity } | Awaited<ReturnType<typeof fail>> | { kind: 'flow'; flow: Flow }
    > => {
      try {
        const identity = await this.engine.opts.identity.resolve(this.run, caller, mode);
        if (mode === 'write' && identity.mode !== 'write') throw new IdentityUnavailable('not_armed');
        return { identity };
      } catch (err) {
        if (!(err instanceof IdentityUnavailable)) return fail(err);
        // A step run again for a write: the write parks on the sign-in, not this step (see `recheck`).
        if (frame.recheck) throw err;
        return { kind: 'flow', flow: await this.parkIdentity(a, err) };
      }
    };
    let identity: ResolvedIdentity | null = null;
    if (handler.external && !handler.plansItself) {
      const r = await resolveIdentity();
      if (!('identity' in r)) return r;
      identity = r.identity;
    }

    // A pass that continues an earlier one reads and checks again before the write goes out (see `recheck`) — not when
    // it only follows a child playbook that already started.
    if (a.beforeSend && !(a.existing?.status === 'waiting' && !a.existing.error)) {
      let checked: Flow | boolean;
      try {
        checked = await a.beforeSend();
      } catch (err) {
        if (err instanceof IdentityUnavailable)
          return { kind: 'flow', flow: await this.parkIdentity(a, err) };
        throw err;
      }
      if (typeof checked === 'object') {
        const stop = checked;
        // Sent before the run stopped (in flight, or failed in a way that may still have taken effect), so the first
        // send may have gone through — and changed what the check read: the run doesn't claim nothing happened, someone
        // checks the target.
        if (stop.kind === 'fail' && a.existing?.status === 'retried') {
          const inFlight = a.existing.error?.code === 'interrupted';
          const error: RunError = {
            code: 'needs_review',
            message: `Step ${a.stepId} ${inFlight ? 'was in flight when the worker stopped' : 'was sent before the run stopped and may have taken effect'}, and ${stop.error.stepId ? `the check ${stop.error.stepId}` : 'a check'} before it no longer holds, so it was not sent again — check whether it took effect.`,
            stepId: a.stepId,
            path,
            details: {
              check: {
                stepId: stop.error.stepId ?? null,
                code: stop.error.code,
                message: stop.error.message,
              },
            },
          };
          await this.close(a.existing, caller, { status: 'needs_review', error });
          return { kind: 'flow', flow: { kind: 'fail', error, policy: 'fail', needsReview: true } };
        }
        // Never sent: a write that waited for write access or a sign-in stops waiting.
        if (stop.kind === 'fail' && a.existing?.status === 'waiting')
          await this.close(a.existing, caller, { status: 'skipped', error: null });
        return { kind: 'flow', flow: stop };
      }
      if (checked) {
        // Checked again: the request is built from what was read now, with access as it is now (disarmed meanwhile?).
        try {
          prep = await handler.prepare(
            a.body as never,
            this.context(a.stepId, path, mode, frame, this.ac.signal, seqRef),
          );
        } catch (err) {
          return fail(err);
        }
        if (handler.external && !handler.plansItself && !intercepted && containsRedacted(prep.payload))
          return fail(redactedValueError());
        if (handler.external && !handler.plansItself) {
          const r = await resolveIdentity();
          if (!('identity' in r)) return r;
          identity = r.identity;
        }
      }
    }

    let attempt = a.existing
      ? a.existing.status === 'retried'
        ? a.existing.attempt + 1
        : a.existing.attempt
      : (a.firstAttempt ?? 1);
    let reuseSeq = a.existing?.status === 'waiting' ? a.existing.seq : undefined;
    for (;;) {
      const rec = this.newRecord(a.stepId, a.type, path, mode, caller, {
        attempt,
        request: prep.request,
        ...(reuseSeq !== undefined ? { seq: reuseSeq } : {}),
      });
      reuseSeq = undefined;
      seqRef.seq = rec.seq;
      await this.save(rec, caller);
      const stepAc = new AbortController();
      const signal = AbortSignal.any([this.ac.signal, stepAc.signal]);
      const ctx = { ...this.context(a.stepId, path, mode, frame, signal, seqRef, spec), identity };
      try {
        let result: StepResult;
        if (intercepted) {
          if ('error' in intercepted) throw intercepted.error;
          result = { output: intercepted.output };
        } else {
          result = await this.withTimeout(a.timeout, stepAc, () => handler.execute(prep, ctx));
        }
        // The lock lapsed while the call was out (another worker has the run): its result is not ours to record.
        const lost = this.disowned();
        if (lost) return { kind: 'flow', flow: { kind: 'interrupted', why: lost } };
        if (result.park) {
          await this.close(rec, caller, {
            status: 'waiting',
            plan: result.plan?.length ? result.plan : null,
            output: result.output ?? null,
            endedAt: null,
          });
          return {
            kind: 'flow',
            flow: {
              kind: 'park',
              status: result.park.status,
              ...(result.park.wakeAt ? { wakeAt: result.park.wakeAt } : {}),
            },
          };
        }
        if (result.error) {
          rec.plan = result.plan?.length ? result.plan : null;
          rec.output = extractSecrets(result.output ?? null, spec).masked ?? null;
          throw new StepError(
            result.error.code,
            result.error.message,
            result.error.details ? { details: result.error.details } : {},
          );
        }
        const plan = planSelf ? [entry, ...(result.plan ?? [])] : (result.plan ?? []);
        const output = await this.secure(result.output ?? null, spec, {
          stepId: a.stepId,
          path,
          seq: rec.seq,
          frame,
          deliver: !this.dryRun,
        });
        await this.close(rec, caller, {
          status: planSelf ? 'planned' : 'succeeded',
          output: output ?? null,
          plan: plan.length ? plan : null,
          msRequestId: result.requestId ?? null,
        });
        return { kind: 'ok', rec };
      } catch (err) {
        // Interrupted mid-call: whether the call took effect is unknown, so the record stays `running` and the next
        // worker decides (retried, or `needs_review` for an `idempotent: false` step).
        const why = RunInterrupted.from(this.ac.signal) ?? RunInterrupted.from(err);
        if (why) return { kind: 'flow', flow: { kind: 'interrupted', why } };
        if (err instanceof IdentityUnavailable) {
          if (frame.recheck) {
            // A step run again for a write: the write parks; this attempt is superseded (see `findStale`).
            await this.close(rec, caller, {
              status: 'retried',
              error: { code: err.reason, message: err.message, stepId: a.stepId, path },
            });
            throw err;
          }
          await this.close(rec, caller, {
            status: 'waiting',
            error: { code: err.reason, message: err.message, stepId: a.stepId, path },
            endedAt: null,
          });
          await this.runEvent('running', undefined, { blockedOn: err.reason, path });
          return { kind: 'flow', flow: { kind: 'park', status: err.parkStatus } };
        }
        if (this.ac.signal.aborted) {
          await this.close(rec, caller, { status: 'cancelled' });
          return { kind: 'flow', flow: { kind: 'cancelled' } };
        }
        const error = toRunError(err, { stepId: a.stepId, path });
        if (isTransientError(err) && a.retry && attempt <= a.retry.max) {
          await this.close(rec, caller, { status: 'retried', error });
          const delay = backoff(a.retry, attempt, retryAfterMs(err));
          await this.emit(rec.seq, {
            type: 'log',
            level: 'warn',
            data: {
              message: `Attempt ${attempt} failed (${error.code}: ${error.message}); retrying in ${Math.round(delay / 100) / 10}s.`,
              path,
            },
          });
          try {
            await this.clock.sleep(
              delay,
              this.interrupt ? AbortSignal.any([this.ac.signal, this.interrupt]) : this.ac.signal,
            );
          } catch {
            if (this.ac.signal.aborted) return { kind: 'flow', flow: this.stopped() };
            const why = this.interruption();
            return { kind: 'flow', flow: why ? { kind: 'interrupted', why } : { kind: 'cancelled' } };
          }
          attempt++;
          continue;
        }
        await this.close(rec, caller, { status: 'failed', error });
        return { kind: 'failed', rec };
      }
    }
  }

  private async parkIdentity(
    a: {
      stepId: string;
      type: string;
      path: string;
      mode: Mode;
      frame: Frame;
      existing: StepRecord | undefined;
    },
    err: IdentityUnavailable,
  ) {
    const rec =
      a.existing?.status === 'waiting'
        ? a.existing
        : this.newRecord(a.stepId, a.type, a.path, a.mode, a.frame.actor, {
            attempt: a.existing ? a.existing.attempt + 1 : 1,
          });
    await this.close(rec, a.frame.actor, {
      status: 'waiting',
      error: { code: err.reason, message: err.message, stepId: a.stepId, path: a.path },
      endedAt: null,
    });
    return { kind: 'park' as const, status: err.parkStatus };
  }

  private async withTimeout<T>(
    timeout: string | undefined,
    ac: AbortController,
    fn: () => Promise<T>,
  ): Promise<T> {
    const own = timeout ? parseDuration(timeout) : Number.POSITIVE_INFINITY;
    const budget = Math.max(1, this.remainingMs());
    const ms = Math.min(own, budget);
    if (!Number.isFinite(ms)) return fn();
    const expired = new Promise<never>((_, reject) => {
      this.clock.timer(ms, ac.signal).then(
        () => {
          const err =
            own <= budget
              ? new StepError('timeout', `The step did not finish within ${timeout}.`)
              : new StepError(
                  'run_timeout',
                  `The run exceeded its time limit of ${Math.round(this.limits.maxRunMs / 60_000)} minutes.`,
                );
          ac.abort(err);
          reject(err);
        },
        () => undefined,
      );
    });
    try {
      return await Promise.race([fn(), expired]);
    } finally {
      if (!ac.signal.aborted) ac.abort();
    }
  }

  // ───────────────────────────── control steps ─────────────────────────────

  private async runBranch(step: BranchStep, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const pre = await this.prelude(step, frame, 'read');
    if ('done' in pre) return pre.done;
    let rec = pre.rec;
    let taken: 'then' | 'else';
    if (rec) taken = (rec.request as { taken?: 'then' | 'else' } | null)?.taken ?? 'else';
    else {
      try {
        taken = truthy(await this.render(step.if, frame)) ? 'then' : 'else';
      } catch (err) {
        const error = toRunError(err, { stepId: step.id, path });
        const failed = this.newRecord(step.id, step.type, path, 'read', frame.actor, {
          status: 'failed',
          error,
          endedAt: this.clock.now(),
        });
        await this.save(failed, frame.actor);
        this.setView(frame, step.id, this.viewOf(failed));
        return this.policy(step, error);
      }
      rec = this.newRecord(step.id, step.type, path, 'read', frame.actor, { request: { taken } });
      await this.save(rec, frame.actor);
      for (const s of (taken === 'then' ? step.else : step.then) ?? []) {
        const p = frame.prefix + s.id;
        if (this.records.has(p)) continue;
        const skipped = this.newRecord(s.id, s.type, p, stepMode(s), frame.actor, {
          status: 'skipped',
          endedAt: this.clock.now(),
          output: null,
        });
        await this.save(skipped, frame.actor);
        this.setView(frame, s.id, this.viewOf(skipped));
      }
    }
    // Always walk the taken list: finished inner steps are reused from their records, which restores their views.
    const flow = await this.runSteps(taken === 'then' ? step.then : (step.else ?? []), frame);
    if (flow.kind === 'ok') {
      if (rec.status !== 'succeeded')
        await this.close(rec, frame.actor, { status: 'succeeded', output: { taken } });
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    if (flow.kind === 'fail') {
      if (rec.status !== 'failed')
        await this.close(rec, frame.actor, { status: 'failed', error: flow.error, output: { taken } });
      this.setView(frame, step.id, this.viewOf(rec));
      if (step.onError === 'continue' && flow.policy === 'fail' && !flow.needsReview) return OK;
      return step.onError === 'compensate' && !flow.needsReview ? { ...flow, policy: 'compensate' } : flow;
    }
    return flow;
  }

  private async runForEach(step: ForEachStep, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const pre = await this.prelude(step, frame, 'read');
    if ('done' in pre) return pre.done;
    let rec = pre.rec;
    let items: unknown[];
    if (rec && Array.isArray((rec.request as { items?: unknown } | null)?.items)) {
      items = (rec.request as { items: unknown[] }).items;
      if (this.maskedRecord(rec, items)) items = await this.restoreItems(step, rec, items, frame);
    } else {
      let raw: unknown;
      try {
        raw = await this.render(step.items, frame);
      } catch (err) {
        return this.failControl(step, frame, toRunError(err, { stepId: step.id, path }));
      }
      if (raw === undefined || raw === null) items = [];
      else if (Array.isArray(raw)) items = raw;
      else
        return this.failControl(step, frame, {
          code: 'invalid_items',
          message: 'forEach items must evaluate to a list.',
          stepId: step.id,
          path,
        });
      const limit = Math.min(step.maxItems ?? this.limits.maxItems, this.limits.maxItems);
      if (items.length > limit)
        return this.failControl(step, frame, {
          code: 'limit_exceeded',
          message: `forEach has ${items.length} items; the limit is ${limit}.`,
          stepId: step.id,
          path,
        });
      rec = this.newRecord(step.id, step.type, path, 'read', frame.actor, {
        request: { items, count: items.length },
      });
      await this.save(rec, frame.actor);
    }
    const loopRec = rec;
    const as = step.as ?? 'item';
    const concurrency = Math.max(1, Math.min(step.concurrency ?? 1, this.limits.maxConcurrency));
    const results: Array<Record<string, unknown> | undefined> = new Array(items.length);
    let next = 0;
    let done = 0;
    let stop = false;
    let failure: Extract<Flow, { kind: 'fail' }> | null = null;
    let park: Extract<Flow, { kind: 'park' }> | null = null;
    /** Cancelled or interrupted: the loop stops as it is (an interrupted one resumes later). */
    let halted: Extract<Flow, { kind: 'cancelled' | 'interrupted' }> | null = null;
    /** Thrown by an iteration: rethrown once the iterations in flight have finished (none keeps going alone). */
    let thrown: { err: unknown } | null = null;
    const iframes: Frame[] = [];

    const iterate = async (index: number) => {
      const iframe: Frame = {
        prefix: `${path}[${index}].`,
        actor: { ...frame.actor },
        locals: new Map(),
        parent: frame,
        vars: { [as]: items[index], index },
        ...(frame.recheck ? { recheck: true } : {}),
        ...(frame.callAs ? { callAs: frame.callAs } : {}),
      };
      iframes.push(iframe);
      const flow = await this.runSteps(step.steps, iframe);
      const outputs: Record<string, unknown> = {};
      let failed = false;
      for (const [id, v] of iframe.locals) {
        outputs[id] = v.output;
        if (v.status === 'failed') failed = true;
      }
      if (flow.kind === 'ok') {
        results[index] = { index, item: items[index], status: failed ? 'failed' : 'succeeded', outputs };
      } else if (flow.kind === 'fail') {
        results[index] = { index, item: items[index], status: 'failed', outputs, error: flow.error };
        if (!(step.onError === 'continue' && flow.policy === 'fail' && !flow.needsReview)) {
          stop = true;
          failure ??= flow;
        }
      } else if (flow.kind === 'park') {
        stop = true;
        park ??= flow;
      } else {
        stop = true;
        halted ??= flow;
      }
      if (flow.kind === 'ok' || flow.kind === 'fail') {
        done++;
        await this.emit(loopRec.seq, { type: 'progress', data: { path, done, total: items.length } });
      }
    };
    const worker = async () => {
      while (!stop && next < items.length) {
        const i = next++;
        try {
          await iterate(i);
        } catch (err) {
          stop = true;
          thrown ??= { err };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));

    if (thrown) throw (thrown as { err: unknown }).err;
    if (halted) return halted;
    const output = results.filter((r): r is Record<string, unknown> => r !== undefined);
    if (failure) {
      const f = failure as Extract<Flow, { kind: 'fail' }>;
      await this.close(loopRec, frame.actor, { status: 'failed', error: f.error, output });
      this.setView(frame, step.id, this.viewOf(loopRec));
      return step.onError === 'compensate' && !f.needsReview ? { ...f, policy: 'compensate' } : f;
    }
    if (park) return park;
    const anyFailed = output.some((r) => r.status === 'failed');
    if (loopRec.status !== (anyFailed ? 'failed' : 'succeeded') || loopRec.endedAt === null) {
      await this.close(loopRec, frame.actor, {
        status: anyFailed ? 'failed' : 'succeeded',
        output,
        error: anyFailed
          ? {
              code: 'items_failed',
              message: `${output.filter((r) => r.status === 'failed').length} of ${items.length} items failed.`,
              stepId: step.id,
              path,
            }
          : null,
      });
    } else loopRec.output = output;
    this.setView(frame, step.id, this.viewOf(loopRec));
    // Reads and checks reused inside the loop that no write in it has covered: the loop is walked again (its items as
    // recorded) before the next write after it, so they run again and its output is rebuilt (see `recheck`).
    if (!frame.recheck && iframes.some((f) => this.pendingRechecks(f))) {
      const asWalked = { ...frame.actor };
      (frame.rechecks ??= []).push({
        order: this.recheckOrder++,
        run: (callAs) => this.runForEach(step, this.recheckFrame(frame, asWalked, callAs)),
      });
    }
    return OK;
  }

  /** forEach items saved masked (see `restoreView`): evaluated again, used only when they mask to what was stored. */
  private async restoreItems(
    step: ForEachStep,
    rec: StepRecord,
    stored: unknown[],
    frame: Frame,
  ): Promise<unknown[]> {
    let fresh: unknown;
    try {
      fresh = await this.render(step.items, frame);
    } catch {
      return stored;
    }
    if (!Array.isArray(fresh) || JSON.stringify(this.mask(fresh)) !== JSON.stringify(stored)) return stored;
    rec.request = { ...(rec.request as Record<string, unknown>), items: fresh };
    return fresh;
  }

  private async failControl(step: Step, frame: Frame, error: RunError): Promise<Flow> {
    const path = frame.prefix + step.id;
    const rec = this.records.get(path) ?? this.newRecord(step.id, step.type, path, 'read', frame.actor);
    await this.close(rec, frame.actor, { status: 'failed', error });
    this.setView(frame, step.id, this.viewOf(rec));
    return this.policy(step, error);
  }

  private approvalTask(
    step: ApprovalStep,
    path: string,
    frame: Frame,
    message: string | null,
    excludes: string[],
  ): HumanTask {
    const a = this.def.approval;
    // Every request expires (ENG-11): an approval left open for weeks would still let the change through.
    const expiresIn = step.expiresIn ?? a?.expiresIn ?? DEFAULT_APPROVAL_EXPIRES_IN;
    return {
      kind: 'approval',
      path,
      stepId: step.id,
      message,
      approvers: step.approvers ?? a?.approvers ?? ['Playbook.Approver'],
      minApprovals: step.minApprovals ?? a?.minApprovals ?? 1,
      expiresAt: iso(new Date(this.clock.now().getTime() + parseDuration(expiresIn))),
      ...(excludes.length ? { excludes } : {}),
      requestedBy: frame.actor,
    };
  }

  /**
   * `excludes` of an approval gate, evaluated as the gate opens: the lower-cased object ids the change grants access
   * to (they may not decide on it). Throws when the expression fails or yields something other than ids, so a gate
   * never opens without the exclusions its author declared.
   */
  private async approvalExcludes(step: ApprovalStep, frame: Frame): Promise<string[]> {
    const expr = step.excludes ?? this.def.approval?.excludes;
    if (expr === undefined) return [];
    const value = await this.render(expr, frame);
    const out = new Set<string>();
    const add = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) return v.forEach(add);
      if (typeof v !== 'string')
        throw new StepError(
          'approval_excludes_invalid',
          'The approval could not tell who it grants access to, so it was not requested.',
          { hint: "Ask the playbook's owner to fix who its approval excludes (object ids)." },
        );
      if (v.trim()) out.add(v.trim().toLowerCase());
    };
    add(value);
    return [...out];
  }

  private async runApproval(step: ApprovalStep, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const pre = await this.prelude(step, frame, 'read');
    if ('done' in pre) return pre.done;
    const rec = pre.rec;
    if (rec?.status === 'succeeded') {
      this.adoptApprover(rec, frame);
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    if (rec && rec.status === 'failed') {
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    if (!rec || rec.status !== 'waiting') {
      // Evaluated in dry runs too, so a preview (and `adminforge test`) catches an `excludes` that can't be worked out.
      let excludes: string[];
      try {
        excludes = await this.approvalExcludes(step, frame);
      } catch (err) {
        return this.failControl(step, frame, toRunError(err, { stepId: step.id, path }));
      }
      if (this.dryRun) {
        const skipped = this.newRecord(step.id, 'approval', path, 'read', frame.actor, {
          status: 'skipped',
          output: { dryRun: true },
          endedAt: this.clock.now(),
        });
        await this.save(skipped, frame.actor);
        this.setView(frame, step.id, this.viewOf(skipped));
        return OK;
      }
      const task = this.approvalTask(
        step,
        path,
        frame,
        await this.describe(step.message, frame, { markdown: true }),
        excludes,
      );
      const { requestedBy: _r, ...request } = task;
      const waiting = this.newRecord(step.id, 'approval', path, 'read', frame.actor, {
        status: 'waiting',
        request,
      });
      await this.save(waiting, frame.actor);
      await this.store.openTask(this.run.id, task);
      return { kind: 'park', status: 'awaiting_approval' };
    }
    const req = rec.request as Omit<Extract<HumanTask, { kind: 'approval' }>, 'requestedBy'>;
    await this.store.openTask(this.run.id, { ...req, kind: 'approval', requestedBy: frame.actor });
    const decision = await this.store.getDecision(this.run.id, path);
    const expired =
      !decision && req.expiresAt !== null && this.clock.now().getTime() >= Date.parse(req.expiresAt);
    if ((!decision || decision.kind !== 'approval') && !expired)
      return { kind: 'park', status: 'awaiting_approval' };
    if (decision?.kind === 'approval' && decision.approved) {
      await this.close(rec, decision.actor, {
        status: 'succeeded',
        actorOid: decision.actor.oid,
        output: {
          decision: 'approved',
          approver: { oid: decision.actor.oid, upn: decision.actor.upn },
          comment: decision.comment ?? null,
          decidedAt: decision.decidedAt,
        },
      });
      this.adoptApprover(rec, frame);
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    const isExpired =
      expired || (decision?.kind === 'approval' && !decision.approved && decision.expired === true);
    const by = decision?.kind === 'approval' ? decision.actor : null;
    const comment = decision?.kind === 'approval' ? decision.comment : null;
    const error: RunError = isExpired
      ? {
          code: 'approval_expired',
          message: 'The approval request expired before anyone approved it.',
          stepId: step.id,
          path,
        }
      : {
          code: 'approval_rejected',
          message: `Rejected by ${by?.upn ?? 'an approver'}${comment ? `: ${comment}` : '.'}`,
          stepId: step.id,
          path,
        };
    await this.close(rec, by, {
      status: 'failed',
      error,
      actorOid: by?.oid ?? null,
      output: {
        decision: isExpired ? 'expired' : 'rejected',
        approver: by ? { oid: by.oid, upn: by.upn } : null,
        comment: comment ?? null,
      },
    });
    this.setView(frame, step.id, this.viewOf(rec));
    return this.policy(step, error);
  }

  /** After an approval, later steps (in this frame) run as the approver — delegated runs only (ADR-010/011). */
  private adoptApprover(rec: StepRecord, frame: Frame) {
    if (this.run.identity !== 'delegated') return;
    const approver = (rec.output as { approver?: { oid: string | null; upn: string | null } } | null)
      ?.approver;
    if (approver?.oid) frame.actor = { kind: 'delegated', oid: approver.oid, upn: approver.upn ?? null };
  }

  private async runManual(step: ManualStep, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const pre = await this.prelude(step, frame, 'read');
    if ('done' in pre) return pre.done;
    const rec = pre.rec;
    if (rec && (rec.status === 'succeeded' || rec.status === 'failed')) {
      // Values typed into `redact: true` fields were saved masked: take the real ones from the decision again.
      if (this.restored.has(path) && Object.values(step.inputs ?? {}).some((p) => p.redact)) {
        const decision = await this.store.getDecision(this.run.id, path);
        if (decision?.kind === 'manual') {
          this.addSecrets(secretInputValues(step.inputs, decision.values ?? {}));
          rec.output = { ...(rec.output as Record<string, unknown>), values: decision.values ?? {} };
        }
      }
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    const task = async (): Promise<HumanTask> => ({
      kind: 'manual',
      path,
      stepId: step.id,
      instructions: (await this.describe(step.instructions, frame, { markdown: true })) ?? '',
      checklist: await Promise.all(
        (step.checklist ?? []).map(async (c) => (await this.describe(c, frame)) ?? ''),
      ),
      requestedBy: frame.actor,
    });
    if (!rec || rec.status !== 'waiting') {
      if (this.dryRun) {
        const skipped = this.newRecord(step.id, 'manual', path, 'read', frame.actor, {
          status: 'skipped',
          output: { dryRun: true },
          endedAt: this.clock.now(),
        });
        await this.save(skipped, frame.actor);
        this.setView(frame, step.id, this.viewOf(skipped));
        return OK;
      }
      const t = await task();
      const { requestedBy: _r, ...request } = t;
      await this.save(
        this.newRecord(step.id, 'manual', path, 'read', frame.actor, { status: 'waiting', request }),
        frame.actor,
      );
      await this.store.openTask(this.run.id, t);
      return { kind: 'park', status: 'awaiting_input' };
    }
    await this.store.openTask(this.run.id, await task());
    const decision = await this.store.getDecision(this.run.id, path);
    if (!decision || decision.kind !== 'manual') return { kind: 'park', status: 'awaiting_input' };
    // Values of the step's `redact: true` fields are masked from here on, like the run's own secret inputs.
    this.addSecrets(secretInputValues(step.inputs, decision.values ?? {}));
    const output = {
      confirmed: decision.confirmed,
      notes: decision.notes ?? null,
      values: decision.values ?? {},
      by: { oid: decision.actor.oid, upn: decision.actor.upn },
      at: decision.decidedAt,
    };
    if (decision.confirmed) {
      await this.close(rec, decision.actor, { status: 'succeeded', output, actorOid: decision.actor.oid });
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    const error: RunError = {
      code: 'manual_declined',
      message: `${decision.actor.upn ?? 'Someone'} did not confirm this step${decision.notes ? `: ${decision.notes}` : '.'}`,
      stepId: step.id,
      path,
    };
    await this.close(rec, decision.actor, { status: 'failed', output, error, actorOid: decision.actor.oid });
    this.setView(frame, step.id, this.viewOf(rec));
    return this.policy(step, error);
  }

  private async runWait(step: WaitStep, frame: Frame): Promise<Flow> {
    const path = frame.prefix + step.id;
    const pre = await this.prelude(step, frame, 'read');
    if ('done' in pre) return pre.done;
    let rec = pre.rec;
    if (rec && (rec.status === 'succeeded' || rec.status === 'failed')) {
      this.setView(frame, step.id, this.viewOf(rec));
      return OK;
    }
    const now = this.clock.now();
    if (this.dryRun) {
      const skipped = this.newRecord(step.id, 'wait', path, 'read', frame.actor, {
        status: 'skipped',
        output: { dryRun: true },
        endedAt: now,
      });
      await this.save(skipped, frame.actor);
      this.setView(frame, step.id, this.viewOf(skipped));
      return OK;
    }
    const startedAt = rec?.status === 'waiting' && rec.startedAt ? rec.startedAt : now;
    const succeed = async (r: StepRecord) => {
      await this.close(r, frame.actor, {
        status: 'succeeded',
        output: { waitedMs: now.getTime() - startedAt.getTime() },
      });
      this.setView(frame, step.id, this.viewOf(r));
      return OK;
    };
    if (step.duration) {
      const wakeAt =
        rec?.status === 'waiting'
          ? new Date((rec.request as { wakeAt: string }).wakeAt)
          : new Date(now.getTime() + parseDuration(step.duration));
      if (!rec || rec.status !== 'waiting') {
        rec = this.newRecord(step.id, 'wait', path, 'read', frame.actor, {
          status: 'waiting',
          request: { wakeAt: iso(wakeAt) },
        });
        await this.save(rec, frame.actor);
      }
      if (now.getTime() >= wakeAt.getTime()) return succeed(rec);
      return { kind: 'park', status: 'running', wakeAt };
    }
    // until: poll the condition every `interval` until it is true or `timeout` passes.
    let cond: unknown;
    try {
      cond = await this.render(step.until!, frame);
    } catch (err) {
      return this.failControl(step, frame, toRunError(err, { stepId: step.id, path }));
    }
    const deadline =
      rec?.status === 'waiting'
        ? new Date((rec.request as { deadline: string }).deadline)
        : new Date(now.getTime() + (step.timeout ? parseDuration(step.timeout) : DEFAULT_WAIT_TIMEOUT_MS));
    if (!rec || rec.status !== 'waiting') {
      rec = this.newRecord(step.id, 'wait', path, 'read', frame.actor, {
        status: 'waiting',
        request: { deadline: iso(deadline), wakeAt: null },
      });
      if (!truthy(cond)) await this.save(rec, frame.actor);
    }
    if (truthy(cond)) return succeed(rec);
    if (now.getTime() >= deadline.getTime()) {
      return this.failControl(step, frame, {
        code: 'wait_timeout',
        message: `The condition was still false after ${step.timeout ?? '1h'}.`,
        stepId: step.id,
        path,
      });
    }
    const interval = step.interval ? parseDuration(step.interval) : DEFAULT_WAIT_INTERVAL_MS;
    const wakeAt = new Date(Math.min(now.getTime() + interval, deadline.getTime()));
    rec.request = { deadline: iso(deadline), wakeAt: iso(wakeAt) };
    await this.save(rec, frame.actor);
    return { kind: 'park', status: 'running', wakeAt };
  }

  // ───────────────────────────── compensation ─────────────────────────────

  /** Actor at the end of the top-level walk: the last top-level approver (delegated runs), else the initiator. */
  private deriveActor(): Actor {
    let actor = this.run.initiator;
    if (this.run.identity !== 'delegated') return actor;
    const approvals = [...this.records.values()]
      .filter((r) => r.type === 'approval' && r.status === 'succeeded' && !r.path.includes('['))
      .sort((a, b) => a.seq - b.seq);
    for (const r of approvals) {
      const approver = (r.output as { approver?: { oid: string | null; upn: string | null } } | null)
        ?.approver;
      if (approver?.oid) actor = { kind: 'delegated', oid: approver.oid, upn: approver.upn ?? null };
    }
    return actor;
  }

  /** Rebuilds the frame a recorded step ran in (loop variables and sibling outputs) to render its compensation. */
  private frameFor(path: string, actor: Actor): Frame {
    const views = (prefix: string) => {
      const m = new Map<string, View>();
      for (const r of this.records.values()) {
        if (!r.path.startsWith(prefix) || r.path.includes('#')) continue;
        const rest = r.path.slice(prefix.length);
        if (!rest.includes('.') && !rest.includes('[')) m.set(r.stepId, this.viewOf(r));
      }
      return m;
    };
    let frame: Frame = { prefix: '', actor, locals: views(''), parent: null, vars: {} };
    const segments = path.split('.').slice(0, -1);
    for (const seg of segments) {
      const m = /^(.+)\[(\d+)\]$/.exec(seg);
      if (!m) break;
      const loopPath = frame.prefix + m[1];
      const items = ((this.records.get(loopPath)?.request as { items?: unknown[] } | null)?.items ??
        []) as unknown[];
      const loopStep = this.byId.get(m[1]!) as ForEachStep | undefined;
      const index = Number(m[2]);
      const prefix = `${loopPath}[${index}].`;
      frame = {
        prefix,
        actor,
        locals: views(prefix),
        parent: frame,
        vars: { [loopStep?.as ?? 'item']: items[index], index },
      };
    }
    return frame;
  }

  private async finishCompensation(failure: RunError): Promise<RunOutcome> {
    const marked = { ...failure, compensating: true };
    const r = await this.store.updateRun(this.run.id, { error: this.mask(marked) }, ['running']);
    if (!r) return this.current();
    this.run = r;
    await this.runEvent('running', undefined, { compensating: true });
    const actor = this.deriveActor();
    const candidates = [...this.records.values()]
      .filter(
        (rec) =>
          (rec.status === 'succeeded' || rec.status === 'planned') &&
          !rec.path.includes('#') &&
          this.byId.get(rec.stepId)?.compensate,
      )
      .sort((a, b) => b.seq - a.seq);
    const failures: Array<{ stepId: string; path: string; message: string }> = [];
    for (const rec of candidates) {
      const halt = this.ac.signal.aborted ? this.stopped() : null;
      if (halt?.kind === 'cancelled') return this.end('cancelled', {});
      const why = halt?.kind === 'interrupted' ? halt.why : this.interruption();
      if (why) return this.pause(why);
      const step = this.byId.get(rec.stepId)!;
      const comp = step.compensate!;
      const cpath = `${rec.path}#compensate`;
      const crec = this.records.get(cpath);
      if (crec && (crec.status === 'succeeded' || crec.status === 'planned')) {
        await this.close(rec, actor, { status: 'compensated', endedAt: rec.endedAt });
        continue;
      }
      if (crec?.status === 'failed') {
        failures.push({
          stepId: rec.stepId,
          path: rec.path,
          message: crec.error?.message ?? 'Compensation failed.',
        });
        continue;
      }
      const handler = this.handlers[comp.type];
      const frame = this.frameFor(rec.path, actor);
      if (!handler) {
        failures.push({ stepId: rec.stepId, path: rec.path, message: `No handler for ${comp.type}.` });
        continue;
      }
      const out = await this.attempt({
        stepId: rec.stepId,
        type: comp.type,
        path: cpath,
        mode: 'write',
        handler,
        body: comp,
        retry: comp.retry,
        timeout: undefined,
        frame,
        describe: comp.describe ?? (step.describe ? `Undo: ${step.describe}` : undefined),
        dryRunOutput: undefined,
        existing:
          crec && (crec.status === 'waiting' || crec.status === 'retried' || crec.status === 'running')
            ? crec.status === 'running'
              ? { ...crec, status: 'retried' }
              : crec
            : undefined,
        compensation: true,
      });
      if (out.kind === 'flow') {
        if (out.flow.kind === 'park' || out.flow.kind === 'interrupted') return this.finish(out.flow);
        if (out.flow.kind === 'cancelled') return this.end('cancelled', {});
        continue;
      }
      if (out.kind === 'failed') {
        failures.push({
          stepId: rec.stepId,
          path: rec.path,
          message: out.rec.error?.message ?? 'Compensation failed.',
        });
        continue;
      }
      await this.close(rec, actor, { status: 'compensated', endedAt: rec.endedAt });
    }
    const error: RunError = {
      ...failure,
      compensating: false,
      ...(failures.length ? { compensationFailures: failures } : {}),
    };
    return this.end(failures.length ? 'needs_review' : 'compensated', { error });
  }
}

/** A Graph read of the caller's own `/me` (its answer depends on whose access it goes out with). */
function readsMe(step: Step): boolean {
  const me = (path: unknown) => typeof path === 'string' && /^\s*\/me(?:[/?]|$)/.test(path);
  if (step.type === 'graph') return me((step.request as { path?: unknown }).path);
  if (step.type === 'graphBatch')
    return Object.values(step.requests).some((r) => me((r as { path?: unknown }).path));
  return false;
}

/** The forEach iterations a step path is inside: `outer[1].inner[0].get` → `['outer[1]', 'inner[0]']`. */
const framesOf = (path: string): string[] => path.split('.').slice(0, -1);

/**
 * Whether a step in `later` frames (which ran after one in `earlier` frames) could build on it: anywhere but another
 * iteration of a forEach both are in (`loop[1].x` doesn't build on `loop[0].get`; `after` and `loop[0].w` build on
 * `get`, and `after` on `loop[0].get`).
 */
function sameStrand(earlier: readonly string[], later: readonly string[]): boolean {
  for (let k = 0; k < Math.min(earlier.length, later.length); k++) {
    if (earlier[k] === later[k]) continue;
    return earlier[k]!.replace(/\[\d+\]$/, '') !== later[k]!.replace(/\[\d+\]$/, '');
  }
  return true;
}

/** Exponential (or fixed) backoff from the policy's first delay (default 1 s), capped at 5 min; Retry-After wins when longer. */
export function backoff(retry: RetryPolicy, attempt: number, retryAfter?: number): number {
  const base = retry.delay ? parseDuration(retry.delay) : 1000;
  let d = (retry.backoff ?? 'exponential') === 'fixed' ? base : base * 2 ** (attempt - 1);
  d = Math.min(d, MAX_BACKOFF_MS);
  if (retryAfter !== undefined) d = Math.max(d, Math.min(retryAfter, MAX_BACKOFF_MS));
  return d;
}
