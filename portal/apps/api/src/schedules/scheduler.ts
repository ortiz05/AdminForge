import { randomUUID } from 'node:crypto';
import { postTeams, sendEmail, type DeliveryDeps, type DeliveryStatus } from '../delivery/notifier';
import type { NotifyTargetSpec } from '@adminforge/schemas';
import { isWriteCapable, parseDuration, type Schedule } from '@adminforge/schemas';
import type { AuditWriter } from '../audit/writer';
import { toErrorInfo } from '../datasources/executor';
import type { DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import { nextRun } from './cron';
import type { ScheduleEvents } from './events';
import type { JobRunner } from './jobs';
import { realTimers, type LeaderElector, type Timers } from './leader';
import type { ScheduleStore } from './store';
import { contentSchedules, contentSignature, syncSchedules } from './sync';
import type { RunErrorInfo, ScheduleRow, ScheduleRunRow, ScheduleRunStatus, ScheduleTrigger } from './types';

/**
 * The scheduler (R6, ADR-011). Only the elected leader fires schedules (Postgres advisory lock; a standby takes over
 * when the leader's connection drops). Each tick: sync content → `schedules`, reap runs a dead scheduler left
 * `running`, fire due cron schedules (overlap policy, concurrency), start due queued runs (run now, retries,
 * `overlap: queue`). Every run is a `schedule_runs` row and an audit event "scheduled by X, executed as automation
 * identity"; failures also raise `schedule.failed` (audit + event). Runs are bounded by `timeoutSeconds`.
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
}

export const DEFAULT_TIMEOUT_SECONDS = 900;
const REAP_GRACE_MS = 120_000;
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
  done: Promise<void>;
}

const timeoutMsOf = (def: Schedule) => (def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

/** Delay before retry `attempt` (1-based): `delay` (default 1 s), doubled per attempt when exponential; capped at 6 h. */
export function retryDelayMs(retry: NonNullable<Schedule['retry']>, attempt: number): number {
  const base = retry.delay ? parseDuration(retry.delay) : 1_000;
  return Math.min(retry.backoff === 'fixed' ? base : base * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
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
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
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
        this.o.log?.warn(
          { schedule: s.key, due: s.nextRunAt.toISOString() },
          'scheduler: missed run skipped (scheduler was not running)',
        );
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
      if (q.trigger !== 'manual' && !s.enabled) {
        await this.o.store.updateRun(
          q.id,
          {
            status: 'skipped',
            endedAt: now,
            result: { ...q.result, reason: 'The schedule was disabled before this run started.' },
          },
          'queued',
        );
        continue;
      }
      if (s.definition.overlap !== 'allow' && busy.has(s.id)) continue;
      const claimed = await this.o.store.updateRun(q.id, { status: 'running', startedAt: now }, 'queued');
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
    const done = this.execute(s, run, controller.signal)
      .then(() => undefined)
      .catch((err: unknown) =>
        this.o.log?.error?.(
          { err: { message: (err as Error).message }, schedule: s.key },
          'scheduler: run bookkeeping failed',
        ),
      )
      .finally(() => {
        this.timers.clearTimeout(timer);
        this.active.delete(run.id);
        this.wake();
      });
    this.active.set(run.id, { scheduleId: s.id, controller, done });
  }

  /** Executes one run to completion and records it (row, schedule status, audit, events, retry). */
  private async execute(
    s: ScheduleRow,
    run: ScheduleRunRow,
    signal: AbortSignal,
  ): Promise<ScheduleRunRow | null> {
    const def = s.definition;
    const requestedBy = typeof run.result?.requestedBy === 'string' ? run.result.requestedBy : null;
    // Run now (and its retries): who asked, by oid — a UPN can't be compared with an approver's oid.
    const requestedByOid = typeof run.result?.requestedByOid === 'string' ? run.result.requestedByOid : null;
    const attempt = typeof run.result?.attempt === 'number' ? run.result.attempt : 0;
    const scheduledBy =
      run.trigger === 'manual' && requestedBy
        ? requestedBy
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
    try {
      if (isWriteCapable(def) && !s.approvedBy)
        throw new AppError(
          403,
          'approval_required',
          'This schedule changes data and runs only after a second person approved enabling it.',
        );
      if (signal.aborted) throw signal.reason;
      const abort = new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      abort.catch(() => undefined);
      const r = await Promise.race([
        this.o.jobs.run({ schedule: s, def, run, signal, correlationId, scheduledBy, requestedByOid }),
        abort,
      ]);
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
      } else {
        status = 'failed';
        const info = toErrorInfo(err);
        error = { code: info.code, message: info.message, ...(info.hint ? { hint: info.hint } : {}) };
      }
    }
    const ended = this.o.now();
    const keep = {
      ...(requestedBy ? { requestedBy } : {}),
      ...(requestedByOid ? { requestedByOid } : {}),
      ...(attempt ? { attempt } : {}),
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
    );
    this.o.events.publish({ type: 'schedule.updated', data: { key: s.key, scheduleRunId: run.id, status } });
    if (status === 'failed' || status === 'timeout')
      await this.failed(s, run, status, error!, attempt, correlationId);
    else if (status === 'succeeded' && s.definition.notify?.onSuccess?.length)
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

  private async auditRun(
    s: ScheduleRow,
    run: ScheduleRunRow,
    status: ScheduleRunStatus,
    durationMs: number,
    error: RunErrorInfo | null,
    scheduledBy: string | null,
    correlationId = randomUUID(),
  ) {
    const def = s.definition;
    const by = scheduledBy ?? s.createdBy ?? `content (owner: ${def.owner})`;
    await this.o.audit
      .append({
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: isWriteCapable(def) ? 'write' : 'read',
        action: 'schedule.run',
        targetType: 'schedule',
        targetId: s.key,
        result: status === 'succeeded' || status === 'skipped' ? 'success' : 'failure',
        correlationId,
        details: {
          summary: `Scheduled by ${by}, executed as automation identity.`,
          scheduleRunId: run.id,
          trigger: run.trigger,
          status,
          job: def.job.kind,
          version: def.version,
          sha256: s.sha256,
          scheduledBy: by,
          approvedBy: s.approvedBy,
          executedAs: 'automation identity',
          durationMs,
          ...(run.runId ? { runId: run.runId } : {}),
          ...(run.artifactPath ? { artifact: run.artifactPath } : {}),
          ...(error ? { error: error.code } : {}),
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
    msg: { title: string; text: string },
    correlationId: string,
  ): Promise<void> {
    const delivery = this.o.delivery;
    const link = delivery ? `${delivery.publicBaseUrl}/schedules/${encodeURIComponent(s.key)}` : undefined;
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
          notify: def.notify?.onFailure?.map((n) => n.type) ?? [],
        },
      })
      .catch(() => undefined);
    this.o.events.publish({
      type: 'schedule.failed',
      data: {
        key: s.key,
        title: def.title,
        scheduleRunId: run.id,
        status,
        error: { code: error.code, message: error.message.slice(0, 500) },
        ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
      },
    });
    // Tell people only when it has really failed (no retry left), so a flaky minute doesn't page anyone.
    if (!retryAt && def.notify?.onFailure?.length)
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
   * interrupted), then release leadership so a standby takes over.
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
