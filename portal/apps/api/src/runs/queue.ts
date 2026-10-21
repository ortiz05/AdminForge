import type { Database } from '../db/client';

/**
 * The run queue (§4.3: `POST /api/runs` → job → worker). One job = "drive run X from its checkpoint". Jobs are keyed
 * by run id — at most one queued and one active job per run (the `stately` policy pg-boss had) — retried with backoff
 * when the handler fails, and deferred with `startAfter` for `wait` steps (an earlier start replaces a later one).
 */

export type RunJobHandler = (runId: string, signal: AbortSignal) => Promise<void>;

/** Thrown by the handler when the run is locked by another worker: the job is retried shortly. */
export class RetryLater extends Error {
  constructor(message = 'Run is busy; retrying') {
    super(message);
    this.name = 'RetryLater';
  }
}

export interface RunQueue {
  readonly kind: 'memory' | 'sqlite';
  start(): Promise<void>;
  enqueue(runId: string, opts?: { startAfter?: Date }): Promise<void>;
  /** Consume jobs (the API process, ADR-016). */
  work(handler: RunJobHandler, opts: { concurrency: number }): Promise<void>;
  stop(): Promise<void>;
}

type Log = { warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };

export interface SqliteQueueOptions {
  /** How often due jobs are looked for (an enqueue in this process wakes the consumer at once). Default 1 s. */
  pollMs?: number;
  /** An active job's lease; renewed every `renewMs`. A process that dies stops renewing, and the job runs again. */
  leaseMs?: number;
  renewMs?: number;
  /** Retry backoff: `retryDelayMs` doubling per failure up to `retryDelayMaxMs`; dropped after `retryLimit`. */
  retryDelayMs?: number;
  retryDelayMaxMs?: number;
  retryLimit?: number;
  /** RetryLater (the run is locked elsewhere): try again after this long, without counting a failure. */
  busyDelayMs?: number;
  /** How long stop() waits for running jobs before aborting them (they are queued again, not lost). */
  gracefulMs?: number;
  now?: () => number;
}

interface ClaimedJob {
  id: number;
  runId: string;
  attempts: number;
  /** This claim's own lease holder: a stale handler of an earlier claim of the same row can't touch this one. */
  holder: string;
}

/**
 * The `run_jobs` table as a queue (replaces pg-boss). Claims happen in an immediate transaction, so a job is driven by
 * one consumer at a time even if two processes poll; the worker's own run lock (a lease) and its stale-run sweep are
 * the second line of defence.
 */
export class SqliteRunQueue implements RunQueue {
  readonly kind = 'sqlite' as const;
  private handler: RunJobHandler | null = null;
  private concurrency = 4;
  /** Running jobs by claim (a row re-claimed after its lease lapsed is a new claim). */
  private readonly active = new Map<string, { job: ClaimedJob; ac: AbortController; done: Promise<void> }>();
  private claims = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private polling = false;
  private again = false;
  private readonly holder: string;
  private readonly o: Required<Omit<SqliteQueueOptions, 'now'>> & { now: () => number };

  constructor(
    private readonly database: Pick<Database, 'sqlite' | 'signals'>,
    private readonly log?: Log,
    opts: SqliteQueueOptions = {},
  ) {
    this.holder = `${database.signals.origin}:runs`;
    this.o = {
      pollMs: opts.pollMs ?? 1_000,
      leaseMs: opts.leaseMs ?? 90_000,
      renewMs: opts.renewMs ?? 30_000,
      retryDelayMs: opts.retryDelayMs ?? 5_000,
      retryDelayMaxMs: opts.retryDelayMaxMs ?? 300_000,
      retryLimit: opts.retryLimit ?? 50,
      busyDelayMs: opts.busyDelayMs ?? 5_000,
      gracefulMs: opts.gracefulMs ?? 10_000,
      now: opts.now ?? Date.now,
    };
  }

  private get sqlite() {
    return this.database.sqlite;
  }

  async start(): Promise<void> {}

  async enqueue(runId: string, opts: { startAfter?: Date } = {}): Promise<void> {
    const t = this.o.now();
    const at = Math.max(t, opts.startAfter?.getTime() ?? t);
    this.upsertQueued(runId, at, 0);
    if (at <= t) this.kick();
  }

  async work(handler: RunJobHandler, opts: { concurrency: number }): Promise<void> {
    this.handler = handler;
    this.concurrency = Math.max(1, opts.concurrency);
    this.stopping = false;
    const every = (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref();
      this.timers.push(t);
    };
    every(() => this.kick(), this.o.pollMs);
    every(() => this.renew(), this.o.renewMs);
    this.kick();
  }

  /** Queued row for a run: the earliest start wins, and a retry keeps the higher failure count. */
  private upsertQueued(runId: string, at: number, attempts: number) {
    this.sqlite
      .prepare(
        `insert into run_jobs (run_id, state, start_after, attempts, created_at) values (?, 'queued', ?, ?, ?)
         on conflict (run_id, state) do update set start_after = min(run_jobs.start_after, excluded.start_after),
           attempts = max(run_jobs.attempts, excluded.attempts)`,
      )
      .run(runId, at, attempts, this.o.now());
  }

  /** Looks for due jobs now (coalesced: a poll already in progress runs once more). */
  private kick() {
    if (!this.handler || this.stopping) return;
    if (this.polling) {
      this.again = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.again = false;
        this.requeueExpired();
        while (this.active.size < this.concurrency && !this.stopping) {
          const job = this.claim();
          if (!job) break;
          this.run(job);
        }
      } while (this.again && !this.stopping);
    } catch (err) {
      this.log?.warn({ err: { message: (err as Error).message } }, 'run queue poll failed');
    } finally {
      this.polling = false;
    }
  }

  private claim(): ClaimedJob | null {
    const t = this.o.now();
    const holder = `${this.holder}:${++this.claims}`;
    const tx = this.sqlite.transaction((): ClaimedJob | null => {
      const row = this.sqlite
        .prepare(
          `select id, run_id as runId, attempts from run_jobs q
            where state = 'queued' and start_after <= ?
              and not exists (select 1 from run_jobs a where a.run_id = q.run_id and a.state = 'active')
            order by start_after, id limit 1`,
        )
        .get(t) as Omit<ClaimedJob, 'holder'> | undefined;
      if (!row) return null;
      this.sqlite
        .prepare("update run_jobs set state = 'active', lease_holder = ?, lease_until = ? where id = ?")
        .run(holder, t + this.o.leaseMs, row.id);
      return { ...row, holder };
    });
    return tx.immediate();
  }

  private run(job: ClaimedJob) {
    const ac = new AbortController();
    const done = (async () => {
      try {
        await this.handler!(job.runId, ac.signal);
        // Stopped mid-run (shutdown): the run isn't finished, so its job goes back in the queue.
        if (ac.signal.aborted) this.release(job, this.o.now(), job.attempts);
        else this.complete(job);
      } catch (err) {
        this.fail(job, err);
      } finally {
        this.active.delete(job.holder);
        this.kick();
      }
    })();
    this.active.set(job.holder, { job, ac, done });
  }

  private complete(job: ClaimedJob) {
    this.sqlite.prepare('delete from run_jobs where id = ? and lease_holder = ?').run(job.id, job.holder);
  }

  /** Ends the active row and queues the run again at `at` (unless a queued row is already earlier). */
  private release(job: ClaimedJob, at: number, attempts: number) {
    this.sqlite
      .transaction(() => {
        this.complete(job);
        this.upsertQueued(job.runId, at, attempts);
      })
      .immediate();
  }

  private fail(job: ClaimedJob, err: unknown) {
    try {
      if (err instanceof RetryLater) {
        this.release(job, this.o.now() + this.o.busyDelayMs, job.attempts);
        return;
      }
      const attempts = job.attempts + 1;
      if (attempts > this.o.retryLimit) {
        this.complete(job);
        (this.log?.error ?? this.log?.warn)?.call(
          this.log,
          { err: { message: (err as Error)?.message }, runId: job.runId, attempts },
          'run job failed too often; dropped (the stale-run sweep queues the run again if it is still open)',
        );
        return;
      }
      this.log?.warn(
        { err: { message: (err as Error)?.message }, runId: job.runId, attempts },
        'run job failed',
      );
      const delay = Math.min(this.o.retryDelayMaxMs, this.o.retryDelayMs * 2 ** (attempts - 1));
      this.release(job, this.o.now() + delay, attempts);
    } catch (e) {
      this.log?.warn(
        { err: { message: (e as Error).message }, runId: job.runId },
        'run job bookkeeping failed',
      );
    }
  }

  /** Active jobs whose lease ran out (their process died) are queued again, counting as a failed attempt. */
  private requeueExpired() {
    const t = this.o.now();
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `delete from run_jobs where state = 'active' and lease_until < ?
               and exists (select 1 from run_jobs q where q.run_id = run_jobs.run_id and q.state = 'queued')`,
          )
          .run(t);
        this.sqlite
          .prepare(
            `update run_jobs set state = 'queued', lease_holder = null, lease_until = null, start_after = ?,
               attempts = attempts + 1
             where state = 'active' and lease_until < ?`,
          )
          .run(t, t);
      })
      .immediate();
  }

  private renew() {
    if (!this.active.size) return;
    try {
      const stmt = this.sqlite.prepare(
        'update run_jobs set lease_until = ? where id = ? and lease_holder = ?',
      );
      const until = this.o.now() + this.o.leaseMs;
      for (const { job } of this.active.values()) stmt.run(until, job.id, job.holder);
    } catch (err) {
      this.log?.warn({ err: { message: (err as Error).message } }, 'run queue lease renewal failed');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const running = () => Promise.allSettled([...this.active.values()].map((a) => a.done));
    const graceful = new Promise((r) => setTimeout(r, this.o.gracefulMs).unref());
    await Promise.race([running(), graceful]);
    // Still running: stop at the next checkpoint; their jobs go back in the queue (run() handles the abort).
    for (const a of this.active.values()) a.ac.abort();
    await Promise.race([running(), new Promise((r) => setTimeout(r, 5_000).unref())]);
    this.handler = null;
  }
}

/**
 * In-process queue for tests and DB-less mock mode: jobs run in this process, serialised per run, with real timers
 * for `startAfter`. `drain()` waits until nothing is running or due.
 */
export class InProcessRunQueue implements RunQueue {
  readonly kind = 'memory' as const;
  private handler: RunJobHandler | null = null;
  private concurrency = 4;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly state = new Map<
    string,
    { running: boolean; again: boolean; timer?: NodeJS.Timeout; at?: number }
  >();
  private readonly pendingStart = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  /** One per running job: aborted when stop() runs out of grace (like the SQLite queue). */
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  /** Errors from handlers (tests assert none). */
  readonly errors: unknown[] = [];

  constructor(
    private readonly log?: Log,
    private readonly retryDelayMs = 50,
    /** How long stop() waits for running jobs before aborting them. */
    private readonly gracefulMs = 10_000,
  ) {}

  async start(): Promise<void> {}

  async enqueue(runId: string, opts: { startAfter?: Date } = {}): Promise<void> {
    if (this.stopped) return;
    const delay = opts.startAfter ? opts.startAfter.getTime() - Date.now() : 0;
    if (delay > 0) {
      const s = this.slot(runId);
      if (s.timer && s.at !== undefined && s.at <= opts.startAfter!.getTime()) return;
      if (s.timer) clearTimeout(s.timer);
      s.at = opts.startAfter!.getTime();
      s.timer = setTimeout(() => {
        s.timer = undefined;
        s.at = undefined;
        this.trigger(runId);
      }, delay);
      s.timer.unref?.();
      return;
    }
    this.trigger(runId);
  }

  async work(handler: RunJobHandler, opts: { concurrency: number }): Promise<void> {
    this.handler = handler;
    this.concurrency = Math.max(1, opts.concurrency);
    for (const id of [...this.pendingStart]) {
      this.pendingStart.delete(id);
      this.trigger(id);
    }
  }

  private slot(runId: string) {
    let s = this.state.get(runId);
    if (!s) this.state.set(runId, (s = { running: false, again: false }));
    return s;
  }

  private trigger(runId: string) {
    if (this.stopped) return;
    if (!this.handler) {
      this.pendingStart.add(runId);
      return;
    }
    const s = this.slot(runId);
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    const p = this.loop(runId, s).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async acquire() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiting.shift()?.();
  }

  private async loop(runId: string, s: { running: boolean; again: boolean }) {
    let failures = 0;
    try {
      do {
        s.again = false;
        await this.acquire();
        const ac = new AbortController();
        this.controllers.add(ac);
        try {
          await this.handler!(runId, ac.signal);
          failures = 0;
        } catch (err) {
          if (!(err instanceof RetryLater)) {
            this.errors.push(err);
            this.log?.warn({ err: { message: (err as Error)?.message }, runId }, 'run job failed');
            if (++failures > 3) break;
          }
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          s.again = true;
        } finally {
          this.controllers.delete(ac);
          this.release();
        }
      } while (s.again && !this.stopped);
    } finally {
      s.running = false;
    }
  }

  /** Resolves once no job is running or immediately due (future `startAfter` timers are ignored). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.inflight.size) {
      if (Date.now() > until) throw new Error('InProcessRunQueue.drain timed out');
      await Promise.race([Promise.all([...this.inflight]), new Promise((r) => setTimeout(r, 50))]);
    }
  }

  /** Stops taking jobs, gives running ones the grace to finish, then aborts them (as a shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.state.values()) if (s.timer) clearTimeout(s.timer);
    const running = () => Promise.allSettled([...this.inflight]);
    await Promise.race([running(), new Promise((r) => setTimeout(r, this.gracefulMs).unref())]);
    for (const ac of this.controllers) ac.abort();
    await Promise.race([running(), new Promise((r) => setTimeout(r, 5_000).unref())]);
  }
}
