import { randomUUID } from 'node:crypto';
import { postTeams, sendEmail, type DeliveryDeps, type DeliveryStatus } from '../delivery/notifier';
import type { NotifyTargetSpec } from '@adminforge/schemas';
import { identityLabel, isWriteCapable, parseDuration, type Schedule } from '@adminforge/schemas';
import type { AuditWriter } from '../audit/writer';
import { toErrorInfo } from '../datasources/executor';
import type { DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import { AUTOMATION_PAUSED } from '../execution/emergency';
import { nextRun } from './cron';
import type { CreatorAccessChecker, CreatorVerdict } from './creator-access';
import { CreatorAccessLost, NeedsSignIn, type PreparedIdentity, type ScheduleIdentities } from './grants';
import type { ScheduleEvents } from './events';
import { scheduledInPortalBy, type JobRunner } from './jobs';
import { realTimers, type LeaderElector, type Timers } from './leader';
import type { ScheduleStore } from './store';
import { contentSchedules, contentSignature, syncSchedules } from './sync';
import type { RunErrorInfo, ScheduleRow, ScheduleRunRow, ScheduleRunStatus, ScheduleTrigger } from './types';
import { runAsOf, writeRunRefusal } from './run-as';

/**
 * The scheduler (R6, ADR-011). It runs in the API process (ADR-016) and fires schedules only while it holds the
 * `adminforge.scheduler` lease (the `leases` table; one pod, ADR-017), so nothing else fires them on their timetable
 * too; a one-shot runs only what it was asked, without the lease. Each tick: sync content → `schedules`, reap runs a
 * dead scheduler left `running`, fire due cron schedules (overlap policy, concurrency; a tick missed by more than the
 * grace period becomes a `skipped` run with `schedule_missed`), start due queued runs (run now, retries,
 * `overlap: queue`), then report progress (the heartbeat /readyz reads). Every run is a `schedule_runs` row and an
 * audit event "scheduled by X, executed as automation identity"; failures also raise `schedule.failed` (audit +
 * event). Runs are bounded by `timeoutSeconds`; a slot stays taken until the job itself ends (capped). Run now on a
 * disabled schedule only writes its file: nothing is emailed, posted or notified.
 */

type Log = {
  info?(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
};

export interface SchedulerOptions {
  store: ScheduleStore;
  definitions: Pick<DefinitionSource, 'list' | 'onChange'>;
  jobs: JobRunner;
  audit: AuditWriter;
  events: ScheduleEvents;
  now: () => Date;
  timers?: Timers;
  /** Jobs at the same time (default 4). */
  concurrency?: number;
  /** Leader election; null = this process is always the scheduler (tests, no database). */
  leader?: LeaderElector | null;
  log?: Log;
  /** A cron tick missed by more than this (scheduler down) is skipped rather than run late (default 1 h). */
  misfireGraceMs?: number;
  /** Longest sleep between ticks (default 30 s). */
  maxIdleMs?: number;
  /** Full content re-sync interval even without change notifications (default 5 min). */
  resyncMs?: number;
  /** Email/Teams for `notify.onFailure` / `notify.onSuccess` (absent: only the audit log and the portal event). */
  delivery?: DeliveryDeps;
  /**
   * Emergency stop (Admin → Settings): while true no schedule fires — due and queued occurrences are recorded as
   * skipped. Runs already going are not stopped (their writes stop when changes are paused too).
   */
  automationPaused?: () => Promise<boolean>;
  /**
   * Schedules created in the portal: confirms before each run that the creator still holds the roles (null = no
   * Entra sign-in, e.g. mock mode: not checked, like the sessions' role re-check).
   */
  creatorAccess?: CreatorAccessChecker | null;
  /**
   * Who each schedule runs as (ADR-014): app identities and creators' grants. Absent: every schedule runs as the
   * automation identity, and one that names its creator can't run.
   */
  identities?: ScheduleIdentities | null;
  /**
   * Called after every tick that went through while this process leads (the scheduler's heartbeat, D-09): a tick
   * that throws, or a scheduler without the lease, reports nothing, so /readyz can tell it isn't working.
   */
  onProgress?: () => void;
}

export const DEFAULT_TIMEOUT_SECONDS = 900;
const REAP_GRACE_MS = 120_000;
/**
 * How long a job told to stop (time limit, lost lease) keeps its slot if it ignores the signal (D-23a). Its run is
 * already recorded; the cap only stops a job that never ends from holding the slot for good.
 */
export const SETTLE_GRACE_MS = REAP_GRACE_MS;
const MAX_RETRY_DELAY_MS = 6 * 3_600_000;
/** Failures a retry cannot fix. */
const PERMANENT = new Set([
  'approval_required',
  'script_not_supported',
  'no_probes',
  'content_unhealthy',
  'export_not_supported',
  'definition_not_found',
  'runs_unavailable',
  'two_person_required',
  'writes_paused',
  'protected_object',
  'creator_access_removed',
  // The creator must sign in for the schedule again; retrying can't help.
  'needs_sign_in',
  'identity_not_configured',
  // The files were written and delivered (marked incomplete); retrying would send the report again.
  'report_incomplete',
]);

class RunAborted extends Error {
  constructor(
    readonly code: 'timeout' | 'interrupted',
    message: string,
  ) {
    super(message);
    this.name = 'RunAborted';
  }
}

interface Active {
  scheduleId: string;
  controller: AbortController;
  /** The run's row, schedule status and audit are written (shutdown waits for this). */
  recorded: Promise<void>;
  /** The slot is free: recorded, and the job itself ended (or SETTLE_GRACE_MS passed after it was told to stop). */
  done: Promise<void>;
}

/** Where `execute` hands back the job's own promise, so the slot can wait for it after a timeout. */
interface JobHandle {
  settled: Promise<void> | null;
}

const timeoutMsOf = (def: Schedule) => (def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

/** Delay before retry `attempt` (1-based): `delay` (default 1 s), doubled per attempt when exponential; capped at 6 h. */
export function retryDelayMs(retry: NonNullable<Schedule['retry']>, attempt: number): number {
  const base = retry.delay ? parseDuration(retry.delay) : 1_000;
  return Math.min(retry.backoff === 'fixed' ? base : base * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/** "07:00 on 12 Oct 2026" in the schedule's own time zone (UTC when the zone isn't known here). */
function formatDue(at: Date, timezone: string): { text: string; zone: string } {
  for (const zone of [timezone, 'UTC'])
    try {
      const part = (o: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...o }).format(at);
      return {
        text: `${part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} on ${part({ day: 'numeric', month: 'short', year: 'numeric' })}`,
        zone,
      };
    } catch {
      // An unknown zone: say it in UTC.
    }
  return { text: at.toISOString(), zone: 'UTC' };
}

/**
 * A tick due more than the grace period ago (F-09): the scheduler wasn't running then. Recorded as `skipped` with
 * this error (the status list has no `missed`; changing its CHECK means a table rebuild).
 */
export function missedError(due: Date, timezone: string): RunErrorInfo {
  const { text, zone } = formatDue(due, timezone);
  return {
    code: 'schedule_missed',
    message: `AdminForge wasn’t running at ${text} (${zone}), so this run was skipped.`,
    hint: 'If you still need this run’s result, run the schedule now. It runs again at its next time as usual.',
  };
}

export class Scheduler {
  private readonly active = new Map<string, Active>();
  private readonly timers: Timers;
  private readonly concurrency: number;
  private leading = false;
  private running = false;
  private timer: unknown = null;
  private ticking: Promise<void> | null = null;
  private again = false;
  private dirty = true;
  private lastSync = 0;
  private signature = '';
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly o: SchedulerOptions) {
    this.timers = o.timers ?? realTimers;
    this.concurrency = o.concurrency ?? 4;
  }

  get isLeader(): boolean {
    return this.leading;
  }

  /** Runs in progress in this process (scheduleRunId → schedule id). */
  get activeRuns(): string[] {
    return [...this.active.keys()];
  }

  /** Starts campaigning for leadership (or leads at once without an elector). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.o.definitions.onChange(() => {
      this.dirty = true;
      this.wake();
    });
    if (this.o.leader) await this.o.leader.start();
    else await this.elected();
  }

  /** Called by the elector (or start) when this process becomes the scheduler. */
  async elected(): Promise<void> {
    if (!this.running) return;
    this.leading = true;
    this.dirty = true;
    this.o.log?.info?.({ concurrency: this.concurrency }, 'scheduler: active');
    await this.tick();
  }

  /** Called by the elector when leadership is lost: stop firing and abort what runs here. */
  async demoted(reason: string): Promise<void> {
    this.leading = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    for (const a of this.active.values())
      a.controller.abort(
        new RunAborted('interrupted', `The scheduler stopped before this run finished (${reason}).`),
      );
    // The rows are written as interrupted; a job that ignores the abort keeps its slot (done) until it ends.
    await Promise.allSettled([...this.active.values()].map((a) => a.recorded));
  }

  /** Ticks as soon as possible (new content, run-now requests, a run finished). */
  wake(): void {
    if (!this.leading || !this.running) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, 0);
  }

  /** One pass (serialised; a tick requested meanwhile runs right after). */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
          if (this.leading) this.o.onProgress?.();
        } catch (err) {
          this.o.log?.warn({ err: { message: (err as Error).message } }, 'scheduler: tick failed');
        }
      } while (this.again && this.leading);
    })().finally(() => {
      this.ticking = null;
      void this.scheduleNext();
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    if (!this.leading) return;
    const now = this.o.now();
    await this.syncIfNeeded(now);
    const paused = (await this.o.automationPaused?.()) === true;
    const schedules = await this.o.store.listSchedules();
    const byId = new Map(schedules.map((s) => [s.id, s]));
    const running = await this.o.store.runsInStatus(['running']);
    await this.reap(running, byId, now);
    const busy = new Set([
      ...running
        .filter(
          (r) =>
            this.active.has(r.id) ||
            now.getTime() - r.startedAt.getTime() <=
              timeoutMsOf(byId.get(r.scheduleId)?.definition ?? ({} as Schedule)) + REAP_GRACE_MS,
        )
        .map((r) => r.scheduleId),
      ...[...this.active.values()].map((a) => a.scheduleId),
    ]);

    for (const s of schedules) {
      if (!this.leading) return;
      if (!s.enabled || !s.nextRunAt || s.nextRunAt.getTime() > now.getTime()) continue;
      // A retired (deleted) definition never fires, even if a toggle raced its deletion: switch it back off.
      if (s.definition.status === 'retired') {
        await this.o.store.updateSchedule(s.id, { enabled: false, nextRunAt: null });
        continue;
      }
      let next: Date | null = null;
      try {
        next = nextRun(s.definition.cron, s.definition.timezone, now);
      } catch (err) {
        this.o.log?.warn(
          { schedule: s.key, err: { message: (err as Error).message } },
          'scheduler: invalid cron',
        );
      }
      const claimed = await this.o.store.updateSchedule(
        s.id,
        { nextRunAt: next },
        { nextRunAt: s.nextRunAt },
      );
      if (!claimed) continue;
      if (now.getTime() - s.nextRunAt.getTime() > (this.o.misfireGraceMs ?? 3_600_000)) {
        // Not run late (a report from Monday 07:00 sent on Monday afternoon would mislead): recorded, so the
        // Schedules page shows it was missed and when.
        this.o.log?.warn(
          { schedule: s.key, due: s.nextRunAt.toISOString() },
          'scheduler: missed run skipped (scheduler was not running)',
        );
        await this.recordSkipped(claimed, 'cron', now, missedError(s.nextRunAt, s.definition.timezone), {
          startedAt: s.nextRunAt,
          extra: { missedAt: s.nextRunAt.toISOString() },
          last: true,
        });
        continue;
      }
      if (paused) {
        await this.skipPaused(claimed, 'cron', now);
        continue;
      }
      await this.fire(claimed, 'cron', now, busy);
    }

    const queued = (await this.o.store.runsInStatus(['queued'])).filter(
      (q) => q.startedAt.getTime() <= now.getTime(),
    );
    for (const q of queued) {
      if (!this.leading || this.active.size >= this.concurrency) break;
      const s = byId.get(q.scheduleId) ?? (await this.o.store.getScheduleById(q.scheduleId));
      if (!s) {
        await this.o.store.updateRun(
          q.id,
          {
            status: 'failed',
            endedAt: now,
            error: { code: 'schedule_not_found', message: 'The schedule no longer exists.' },
          },
          'queued',
        );
        continue;
      }
      if (paused) {
        await this.skipPaused(s, q.trigger, now, q);
        continue;
      }
      // A retired (deleted) schedule never runs, not even a run now that was queued before it was deleted.
      const retired = s.definition.status === 'retired';
      if (retired || (q.trigger !== 'manual' && !s.enabled)) {
        await this.o.store.updateRun(
          q.id,
          {
            status: 'skipped',
            endedAt: now,
            result: {
              ...q.result,
              reason: retired
                ? 'The schedule was deleted before this run started.'
                : 'The schedule was disabled before this run started.',
            },
          },
          'queued',
        );
        continue;
      }
      if (s.definition.overlap !== 'allow' && busy.has(s.id)) continue;
      // A Run now queued while the schedule was enabled, and disabled before it started, is file only too (F-10):
      // decided from this pass's row, not only when it was asked for.
      const fileOnly = q.trigger === 'manual' && !s.enabled && q.result?.fileOnly !== true;
      const claimed = await this.o.store.updateRun(
        q.id,
        {
          status: 'running',
          startedAt: now,
          ...(fileOnly ? { result: { ...q.result, fileOnly: true } } : {}),
        },
        'queued',
      );
      if (!claimed) continue;
      busy.add(s.id);
      this.launch(s, claimed);
    }
  }

  private async syncIfNeeded(now: Date) {
    if (!this.dirty && now.getTime() - this.lastSync < (this.o.resyncMs ?? 300_000)) return;
    const content = await contentSchedules(this.o.definitions);
    const sig = contentSignature(content);
    this.dirty = false;
    this.lastSync = now.getTime();
    const r = await syncSchedules(this.o.store, content, now);
    if (r.inserted.length || r.updated.length || sig !== this.signature) {
      this.signature = sig;
      if (r.inserted.length || r.updated.length)
        this.o.log?.info?.(
          { inserted: r.inserted.length, updated: r.updated.length },
          'scheduler: schedules synced from content',
        );
    }
  }

  /** Marks runs a dead scheduler left `running` (older than their timeout plus a grace period) as interrupted. */
  private async reap(running: ScheduleRunRow[], byId: Map<string, ScheduleRow>, now: Date) {
    for (const r of running) {
      if (this.active.has(r.id)) continue;
      const s = byId.get(r.scheduleId);
      const limit = timeoutMsOf(s?.definition ?? ({} as Schedule)) + REAP_GRACE_MS;
      if (now.getTime() - r.startedAt.getTime() <= limit) continue;
      const error = { code: 'interrupted', message: 'The scheduler stopped before this run finished.' };
      if (await this.o.store.updateRun(r.id, { status: 'failed', endedAt: now, error }, 'running')) {
        if (s && s.lastStatus === 'running')
          await this.o.store.updateSchedule(s.id, { lastStatus: 'failed' });
        this.o.log?.warn(
          { schedule: r.scheduleKey, scheduleRunId: r.id },
          'scheduler: reaped an interrupted run',
        );
      }
    }
  }

  /**
   * Whether the run before `currentRunId` already ended waiting for the creator's sign-in: a "Me" schedule nobody has
   * signed in for yet fails (and notifies) once, then skips quietly like one whose sign-in was lost.
   */
  private async alreadyWaitingForSignIn(scheduleId: string, currentRunId: string): Promise<boolean> {
    const recent = await this.o.store.listRuns(scheduleId, { limit: 3 });
    const previous = recent.find(
      (r) => r.id !== currentRunId && r.status !== 'running' && r.status !== 'queued',
    );
    return previous?.error?.code === 'needs_sign_in';
  }

  /** Automation is paused: the occurrence (a due tick, or a queued run) is recorded as skipped with why, and audited. */
  private skipPaused(
    s: ScheduleRow,
    trigger: ScheduleTrigger,
    now: Date,
    queued?: ScheduleRunRow,
    extra: Record<string, unknown> = {},
  ) {
    return this.recordSkipped(s, trigger, now, { ...AUTOMATION_PAUSED }, { queued, extra });
  }

  /**
   * An occurrence that didn't run (automation paused, a missed tick): a `skipped` row whose `error` says why and what
   * to do, audited (`schedule.run`) and announced (`schedule.updated`). `queued` turns a waiting run into it;
   * `startedAt` dates the row (a missed tick: when it was due); `last` makes it the schedule's last run in the lists.
   */
  private async recordSkipped(
    s: ScheduleRow,
    trigger: ScheduleTrigger,
    now: Date,
    error: RunErrorInfo,
    opts: {
      queued?: ScheduleRunRow;
      extra?: Record<string, unknown>;
      startedAt?: Date;
      last?: boolean;
    } = {},
  ) {
    const { queued } = opts;
    const fields = {
      status: 'skipped' as const,
      endedAt: now,
      result: { ...queued?.result, ...opts.extra, reason: error.message },
      error,
    };
    const run = queued
      ? await this.o.store.updateRun(queued.id, fields, 'queued')
      : await this.o.store.insertRun({
          scheduleId: s.id,
          scheduleKey: s.key,
          trigger,
          startedAt: opts.startedAt ?? now,
          ...fields,
        });
    if (!run) return null;
    if (opts.last)
      await this.o.store.updateSchedule(s.id, { lastRunAt: run.startedAt, lastStatus: 'skipped' });
    await this.auditRun(s, run, 'skipped', 0, error, null);
    this.o.events.publish({
      type: 'schedule.updated',
      data: { key: s.key, scheduleRunId: run.id, status: 'skipped' },
    });
    return run;
  }

  /** A cron tick: apply the overlap policy and concurrency, then start (or queue / skip) a run. */
  private async fire(s: ScheduleRow, trigger: ScheduleTrigger, now: Date, busy: Set<string>) {
    const overlap = s.definition.overlap ?? 'skip';
    if (busy.has(s.id) && overlap !== 'allow') {
      if (overlap === 'queue') {
        await this.o.store.insertRun({
          scheduleId: s.id,
          scheduleKey: s.key,
          trigger,
          status: 'queued',
          startedAt: now,
        });
        return;
      }
      const run = await this.o.store.insertRun({
        scheduleId: s.id,
        scheduleKey: s.key,
        trigger,
        status: 'skipped',
        startedAt: now,
        endedAt: now,
        result: { reason: 'The previous run was still running (overlap: skip).' },
      });
      await this.auditRun(s, run, 'skipped', 0, null, null);
      return;
    }
    if (this.active.size >= this.concurrency) {
      await this.o.store.insertRun({
        scheduleId: s.id,
        scheduleKey: s.key,
        trigger,
        status: 'queued',
        startedAt: now,
      });
      return;
    }
    const run = await this.o.store.insertRun({
      scheduleId: s.id,
      scheduleKey: s.key,
      trigger,
      status: 'running',
      startedAt: now,
    });
    busy.add(s.id);
    this.launch(s, run);
  }

  private launch(s: ScheduleRow, run: ScheduleRunRow) {
    const controller = new AbortController();
    const timeoutSeconds = s.definition.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const timer = this.timers.setTimeout(
      () =>
        controller.abort(
          new RunAborted('timeout', `Stopped after the ${timeoutSeconds} s time limit (timeoutSeconds).`),
        ),
      timeoutSeconds * 1000,
    );
    const job: JobHandle = { settled: null };
    const recorded = this.execute(s, run, controller.signal, job)
      .then(() => undefined)
      .catch((err: unknown) =>
        this.o.log?.error?.(
          { err: { message: (err as Error).message }, schedule: s.key },
          'scheduler: run bookkeeping failed',
        ),
      );
    // The slot stays taken until the job itself ends, not just its record (D-23a): a job that ignores the abort
    // still holds outbound slots and loop time here, and its schedule's overlap policy still applies.
    const done = recorded
      .then(() => this.settle(s, run, controller.signal, job.settled))
      .finally(() => {
        this.timers.clearTimeout(timer);
        this.active.delete(run.id);
        this.wake();
      });
    this.active.set(run.id, { scheduleId: s.id, controller, recorded, done });
  }

  /** Waits for a job that was told to stop, at most SETTLE_GRACE_MS; says so if it never ended. */
  private async settle(s: ScheduleRow, run: ScheduleRunRow, signal: AbortSignal, job: Promise<void> | null) {
    if (!job) return;
    if (!signal.aborted) return job;
    let cap: unknown = null;
    const capped = await Promise.race([
      job.then(() => false),
      new Promise<boolean>((resolve) => {
        cap = this.timers.setTimeout(() => resolve(true), SETTLE_GRACE_MS);
      }),
    ]);
    this.timers.clearTimeout(cap);
    if (capped)
      this.o.log?.warn(
        { schedule: s.key, scheduleRunId: run.id },
        'scheduler: a job ignored its stop signal; its slot is free again',
      );
  }

  /** Executes one run to completion and records it (row, schedule status, audit, events, retry). */
  private async execute(
    s: ScheduleRow,
    run: ScheduleRunRow,
    signal: AbortSignal,
    job: JobHandle = { settled: null },
  ): Promise<ScheduleRunRow | null> {
    const def = s.definition;
    const requestedBy = typeof run.result?.requestedBy === 'string' ? run.result.requestedBy : null;
    // Run now (and its retries): who asked, by oid — a UPN can't be compared with an approver's oid.
    const requestedByOid = typeof run.result?.requestedByOid === 'string' ? run.result.requestedByOid : null;
    const attempt = typeof run.result?.attempt === 'number' ? run.result.attempt : 0;
    // Run now while the schedule is disabled (F-10): the job writes its file, nobody is emailed, posted or notified.
    const fileOnly = run.result?.fileOnly === true;
    // Portal schedules: the creator's UPN (the row keeps their oid; the definition's owner is their UPN).
    const scheduledBy =
      run.trigger === 'manual' && requestedBy
        ? requestedBy
        : s.source === 'portal'
          ? def.owner
          : (s.createdBy ?? `content (owner: ${def.owner})`);
    const correlationId = randomUUID();
    const started = this.o.now();
    await this.o.store.updateSchedule(s.id, { lastRunAt: run.startedAt, lastStatus: 'running' });
    this.o.events.publish({
      type: 'schedule.updated',
      data: { key: s.key, scheduleRunId: run.id, status: 'running' },
    });

    let status: ScheduleRunStatus;
    let error: RunErrorInfo | null;
    let result: Record<string, unknown> | null = null;
    let runId: string | null = null;
    let artifactPath: string | null = null;
    let runAs: PreparedIdentity | null = null;
    const asCreator = def.identity !== 'automation' && 'user' in def.identity;
    try {
      // Changes data: only after a second person approved it, and only as the account that approval covered.
      const refused =
        isWriteCapable(def) && writeRunRefusal(s, this.o.identities?.runAs(s) ?? runAsOf(s).identity);
      if (refused) throw refused;
      if (s.source === 'portal' && this.o.creatorAccess) await this.confirmCreator(s, run, correlationId);
      if (this.o.identities)
        runAs = await this.o.identities.prepare(s, await this.creatorRoles(s)).catch(async (err: unknown) => {
          // Entra says the creator lost what the schedule needs (roles, account): their grant is gone, so turn it off.
          if (err instanceof CreatorAccessLost)
            // (prepare already removed the grant.)
            await this.turnOffForCreator(s, run, correlationId, {
              detail: err.detail,
              ...(err.missing.length ? { missingRoles: err.missing } : {}),
              grantRemoved: true,
            });
          throw err;
        });
      else if (def.identity !== 'automation')
        throw new AppError(
          503,
          'identity_not_configured',
          'This AdminForge runs schedules only as the automation identity.',
          { hint: 'Run it as the automation identity, or run the scheduler with Entra sign-in configured.' },
        );
      if (signal.aborted) throw signal.reason;
      const abort = new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      abort.catch(() => undefined);
      const running = this.o.jobs.run({
        schedule: s,
        def,
        run,
        signal,
        correlationId,
        scheduledBy,
        requestedByOid,
        ...(runAs ? { identity: runAs.identity, user: runAs.user } : {}),
        ...(fileOnly ? { fileOnly: true } : {}),
      });
      job.settled = running.then(
        () => undefined,
        () => undefined,
      );
      const r = await Promise.race([running, abort]);
      status = r.status ?? 'succeeded';
      result = r.result ?? null;
      runId = r.runId ?? null;
      artifactPath = r.artifactPath ?? null;
      error = r.error ?? null;
    } catch (err) {
      const reason = signal.aborted ? signal.reason : err;
      if (reason instanceof RunAborted) {
        status = reason.code === 'timeout' ? 'timeout' : 'failed';
        error = { code: reason.code, message: reason.message };
      } else if (
        reason instanceof NeedsSignIn &&
        (reason.known || (await this.alreadyWaitingForSignIn(s.id, run.id)))
      ) {
        // Already waiting for the creator to sign in (a lost grant, or one never given whose first run already said
        // so): recorded, without telling anyone again.
        status = 'skipped';
        error = {
          code: reason.code,
          message: reason.message,
          ...(reason.extras.hint ? { hint: reason.extras.hint } : {}),
        };
        result = { reason: reason.message };
      } else {
        status = 'failed';
        const info = toErrorInfo(err);
        error = { code: info.code, message: info.message, ...(info.hint ? { hint: info.hint } : {}) };
      }
    }
    // Microsoft refused the creator's stored access in the middle of the run: the schedule now needs sign-in.
    if (asCreator && runAs && error?.code === 'reauth' && this.o.identities) {
      await this.o.identities.markNeedsSignIn(s.id, 'reauth');
      const n = new NeedsSignIn(def.owner, false);
      error = { code: n.code, message: n.message, ...(n.extras.hint ? { hint: n.extras.hint } : {}) };
    }
    const executedAs = runAs?.executedAs ?? identityLabel(def.identity, def.owner);
    const ended = this.o.now();
    const keep = {
      ...(requestedBy ? { requestedBy } : {}),
      ...(requestedByOid ? { requestedByOid } : {}),
      ...(attempt ? { attempt } : {}),
      ...(fileOnly ? { fileOnly: true } : {}),
    };
    const finalResult = result || Object.keys(keep).length ? { ...result, ...keep } : null;
    const row = await this.o.store.updateRun(
      run.id,
      { status, endedAt: ended, result: finalResult, error, runId, artifactPath },
      'running',
    );
    await this.o.store.updateSchedule(s.id, { lastStatus: status });
    await this.auditRun(
      s,
      { ...run, result: finalResult, runId, artifactPath },
      status,
      ended.getTime() - started.getTime(),
      error,
      scheduledBy,
      correlationId,
      executedAs,
    );
    this.o.events.publish({ type: 'schedule.updated', data: { key: s.key, scheduleRunId: run.id, status } });
    if (status === 'failed' || status === 'timeout')
      await this.failed(s, run, status, error!, attempt, correlationId, fileOnly);
    else if (status === 'succeeded' && !fileOnly && s.definition.notify?.onSuccess?.length)
      await this.notify(
        s,
        s.definition.notify.onSuccess,
        {
          title: `${s.definition.title} ran`,
          text: `The schedule "${s.definition.title}" finished successfully. Reference: ${correlationId}.`,
        },
        correlationId,
      );
    return row;
  }

  /**
   * A schedule created in the portal runs only while its creator could still create it: an enabled member holding
   * Portal.Operator and every role the schedule and the report (current version) require. Confirmed loss → the run
   * fails with `creator_access_removed` and the schedule is turned off (audited); can't tell → `creator_unverified`
   * (this run only; the schedule stays on).
   */
  /** The roles a creator must hold for a schedule they made: Portal.Operator, the schedule's and the report's. */
  private async creatorRoles(s: ScheduleRow): Promise<string[]> {
    const def = s.definition;
    const ref = def.job.kind === 'report' ? def.job.ref : null;
    const report = ref ? (await this.o.definitions.list('report')).find((r) => r.key === ref) : undefined;
    return [
      ...new Set([
        'Portal.Operator',
        ...(def.requires?.portalRoles ?? []),
        ...(report?.def.requires?.portalRoles ?? []),
      ]),
    ];
  }

  private async confirmCreator(s: ScheduleRow, run: ScheduleRunRow, correlationId: string): Promise<void> {
    const def = s.definition;
    const roles = await this.creatorRoles(s);
    const verdict: CreatorVerdict = s.createdBy
      ? await this.o.creatorAccess!.check(s.createdBy, roles, correlationId)
      : { status: 'unverified', problem: 'The schedule has no creator.' };
    if (verdict.status === 'ok') return;
    if (verdict.status === 'unverified')
      throw new AppError(
        503,
        'creator_unverified',
        `AdminForge couldn’t confirm that ${def.owner}, who created this schedule, still has access, so it didn’t run.`,
        {
          hint: 'It tries again at its next time. If this keeps happening, an administrator should check that the automation identity can read users, group memberships and enterprise apps (User.Read.All, GroupMember.Read.All, Application.Read.All).',
        },
      );
    const why =
      verdict.reason === 'not_found'
        ? 'their account no longer exists'
        : verdict.reason === 'disabled'
          ? 'their account is disabled'
          : verdict.reason === 'guest'
            ? 'their account is now a guest'
            : `they no longer hold the ${verdict.missing!.join(' and ')} role`;
    await this.turnOffForCreator(s, run, correlationId, {
      detail: verdict.reason,
      ...(verdict.missing ? { missingRoles: verdict.missing } : {}),
    });
    throw new AppError(
      403,
      'creator_access_removed',
      `${def.owner} created this schedule, but ${why}, so it was turned off and didn’t run.`,
      {
        hint: 'Someone who may open the report can schedule it again from Reports; turning this one back on works only once the creator’s access is restored.',
      },
    );
  }

  /**
   * The creator lost access: the schedule is turned off (audited `schedule.disabled`) and, for one that runs with
   * their own access, their grant and its sealed tokens are removed — nothing of theirs outlives their access.
   */
  private async turnOffForCreator(
    s: ScheduleRow,
    run: ScheduleRunRow,
    correlationId: string,
    why: Record<string, unknown>,
  ): Promise<void> {
    const def = s.definition;
    await this.o.store.updateSchedule(s.id, { enabled: false, nextRunAt: null });
    const asCreator = def.identity !== 'automation' && 'user' in def.identity;
    if (asCreator && !why.grantRemoved) await this.o.identities?.remove(s.id);
    await this.o.audit
      .append({
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: 'read',
        action: 'schedule.disabled',
        targetType: 'schedule',
        targetId: s.key,
        result: 'success',
        correlationId,
        details: {
          reason: 'creator_access_removed',
          createdBy: def.owner,
          creatorOid: s.createdBy,
          ...why,
          ...(asCreator ? { grantRemoved: true } : {}),
          scheduleRunId: run.id,
          version: def.version,
          sha256: s.sha256,
        },
      })
      .catch((err: unknown) =>
        this.o.log?.error?.({ err: { message: (err as Error).message } }, 'scheduler: audit failed'),
      );
    this.o.events.publish({ type: 'schedules.changed', data: { key: s.key } });
  }

  private async auditRun(
    s: ScheduleRow,
    run: ScheduleRunRow,
    status: ScheduleRunStatus,
    durationMs: number,
    error: RunErrorInfo | null,
    scheduledBy: string | null,
    correlationId = randomUUID(),
    executedAs = identityLabel(s.definition.identity, s.definition.owner),
  ) {
    const def = s.definition;
    // Portal schedules: the creator's UPN (the row keeps their oid), also for skipped runs.
    const by =
      scheduledBy ??
      (s.source === 'portal' ? def.owner : null) ??
      s.createdBy ??
      `content (owner: ${def.owner})`;
    // A probe job whose synthetic transactions acted on the tenant (ADR-015) changed something: audited as a write.
    const transactions = Number(run.result?.transactions ?? 0);
    await this.o.audit
      .append({
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: isWriteCapable(def) || transactions > 0 ? 'write' : 'read',
        action: 'schedule.run',
        targetType: 'schedule',
        targetId: s.key,
        result: status === 'succeeded' || status === 'skipped' ? 'success' : 'failure',
        correlationId,
        details: {
          summary: `Scheduled by ${by}, executed as ${executedAs}.`,
          scheduleRunId: run.id,
          trigger: run.trigger,
          status,
          job: def.job.kind,
          version: def.version,
          sha256: s.sha256,
          scheduledBy: by,
          approvedBy: s.approvedBy,
          executedAs,
          durationMs,
          ...(run.runId ? { runId: run.runId } : {}),
          ...(run.artifactPath ? { artifact: run.artifactPath } : {}),
          ...(error ? { error: error.code } : {}),
          // Whether it could have delivered anything, and which occurrence a missed run was.
          ...(run.result?.fileOnly === true ? { fileOnly: true } : {}),
          ...(typeof run.result?.missedAt === 'string' ? { missedAt: run.result.missedAt } : {}),
          ...(transactions > 0 ? { transactions: run.result?.transactionCodes } : {}),
        },
      })
      .catch((err: unknown) =>
        this.o.log?.error?.({ err: { message: (err as Error).message } }, 'scheduler: audit failed'),
      );
  }

  /** Sends a schedule's email/Teams notifications; outcomes are audited (never thrown). */
  private async notify(
    s: ScheduleRow,
    targets: readonly NotifyTargetSpec[],
    message: { title: string; text: string },
    correlationId: string,
  ): Promise<void> {
    let msg = message;
    const delivery = this.o.delivery;
    const link = delivery ? `${delivery.publicBaseUrl}/schedules/${encodeURIComponent(s.key)}` : undefined;
    // A schedule created in the portal says who made it.
    const byline = scheduledInPortalBy(s);
    if (byline) msg = { ...msg, text: `${msg.text}\n${byline}` };
    const results: DeliveryStatus[] = [];
    for (const t of targets) {
      if (!delivery)
        results.push({ type: t.type, status: 'not_configured', message: 'Delivery is not available.' });
      else if (t.type === 'email')
        results.push(
          await sendEmail(
            delivery,
            { to: t.to, ...(t.cc ? { cc: t.cc } : {}) },
            { title: t.subject ?? msg.title, text: t.message ?? msg.text, ...(link ? { link } : {}) },
            correlationId,
          ),
        );
      else results.push(await postTeams(delivery, t.webhook, { ...msg, ...(link ? { link } : {}) }));
    }
    await this.o.audit
      .append({
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: 'read',
        action: 'schedule.notified',
        targetType: 'schedule',
        targetId: s.key,
        result: results.every((r) => r.status === 'sent') ? 'success' : 'failure',
        correlationId,
        details: { results: results.map((r) => ({ type: r.type, status: r.status, message: r.message })) },
      })
      .catch(() => undefined);
  }

  /** Failure notification (audit + event), then a retry when the policy allows. */
  private async failed(
    s: ScheduleRow,
    run: ScheduleRunRow,
    status: ScheduleRunStatus,
    error: RunErrorInfo,
    attempt: number,
    correlationId: string,
    fileOnly = false,
  ) {
    const def = s.definition;
    const retry = def.retry;
    const willRetry =
      !!retry && attempt < retry.max && !PERMANENT.has(error.code) && error.code !== 'interrupted';
    const retryAt = willRetry ? new Date(this.o.now().getTime() + retryDelayMs(retry!, attempt + 1)) : null;
    await this.o.audit
      .append({
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: isWriteCapable(def) ? 'write' : 'read',
        action: 'schedule.failed',
        targetType: 'schedule',
        targetId: s.key,
        result: 'failure',
        correlationId,
        details: {
          scheduleRunId: run.id,
          status,
          error,
          attempt,
          ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
          notify: fileOnly ? [] : (def.notify?.onFailure?.map((n) => n.type) ?? []),
          ...(fileOnly ? { fileOnly: true } : {}),
        },
      })
      .catch(() => undefined);
    // Every signed-in browser gets this: metadata only (the message is in the role-gated run history).
    this.o.events.publish({
      type: 'schedule.failed',
      data: {
        key: s.key,
        scheduleRunId: run.id,
        status,
        error: { code: error.code },
        ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
      },
    });
    // Tell people only when it has really failed (no retry left), so a flaky minute doesn't page anyone — and not
    // for a file-only run (the person who ran it sees it in the history).
    if (!retryAt && !fileOnly && def.notify?.onFailure?.length)
      await this.notify(
        s,
        def.notify.onFailure,
        {
          title: `${def.title} failed`,
          text: `The schedule "${def.title}" ${status === 'timeout' ? 'timed out' : 'failed'}: ${error.message.slice(0, 300)}\nReference: ${correlationId}.`,
        },
        correlationId,
      );
    if (retryAt)
      await this.o.store.insertRun({
        scheduleId: s.id,
        scheduleKey: s.key,
        trigger: 'retry',
        status: 'queued',
        startedAt: retryAt,
        result: {
          attempt: attempt + 1,
          retryOf: run.id,
          ...(typeof run.result?.requestedBy === 'string' ? { requestedBy: run.result.requestedBy } : {}),
          ...(typeof run.result?.requestedByOid === 'string'
            ? { requestedByOid: run.result.requestedByOid }
            : {}),
          ...(fileOnly ? { fileOnly: true } : {}),
        },
      });
  }

  private async scheduleNext() {
    if (!this.leading || !this.running) return;
    let delay = this.o.maxIdleMs ?? 30_000;
    try {
      const now = this.o.now().getTime();
      for (const s of await this.o.store.listSchedules())
        if (s.enabled && s.nextRunAt) delay = Math.min(delay, s.nextRunAt.getTime() - now);
      for (const q of await this.o.store.runsInStatus(['queued']))
        delay = Math.min(delay, q.startedAt.getTime() - now);
    } catch {
      // keep the idle delay
    }
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(delay, 250),
    );
  }

  /**
   * Runs one schedule now in this process, without leadership (CLI `--schedule`): the run row, audit and events are
   * the same as for a run the leader starts.
   */
  async runOnce(key: string, requestedBy: string): Promise<ScheduleRunRow> {
    const now = this.o.now();
    await syncSchedules(this.o.store, await contentSchedules(this.o.definitions), now);
    const s = await this.o.store.getSchedule(key);
    if (!s) throw new AppError(404, 'schedule_not_found', `No schedule "${key}".`);
    if ((await this.o.automationPaused?.()) === true) {
      const skipped = await this.skipPaused(s, 'manual', now, undefined, { requestedBy });
      if (skipped) return skipped;
    }
    const run = await this.o.store.insertRun({
      scheduleId: s.id,
      scheduleKey: s.key,
      trigger: 'manual',
      status: 'running',
      startedAt: now,
      result: { requestedBy },
    });
    const controller = new AbortController();
    const timeoutSeconds = s.definition.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const timer = this.timers.setTimeout(
      () =>
        controller.abort(
          new RunAborted('timeout', `Stopped after the ${timeoutSeconds} s time limit (timeoutSeconds).`),
        ),
      timeoutSeconds * 1000,
    );
    try {
      return (await this.execute(s, run, controller.signal)) ?? (await this.o.store.getRun(run.id))!;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Waits for every run in progress here (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.active.size || this.ticking) {
      await Promise.allSettled([...this.active.values()].map((a) => a.done));
      if (this.ticking) await this.ticking;
    }
  }

  /**
   * Graceful shutdown: stop firing, let running jobs finish for up to `graceMs`, abort the rest (recorded as
   * interrupted), then release the lease so the next pod (or process) can take it at once instead of waiting for it to
   * expire.
   */
  async stop(graceMs = 30_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    const pending = [...this.active.values()].map((a) => a.done);
    if (pending.length) {
      let t: unknown;
      const graceful = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((r) => (t = setTimeout(() => r(false), graceMs))),
      ]);
      clearTimeout(t as NodeJS.Timeout);
      if (!graceful) await this.demoted('shutting down');
    }
    this.leading = false;
    await this.o.leader?.stop();
  }
}
