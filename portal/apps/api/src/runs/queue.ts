import { PgBoss } from 'pg-boss';

/**
 * The run queue (§4.3: `POST /api/runs` → pg-boss job → worker). One job = "drive run X from its checkpoint". Jobs are
 * keyed by run id (pg-boss `stately` policy: at most one queued and one active job per run), retried with backoff
 * when a worker fails or dies (heartbeats), and deferred with `startAfter` for `wait` steps.
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
  readonly kind: 'memory' | 'pg-boss';
  start(): Promise<void>;
  enqueue(runId: string, opts?: { startAfter?: Date }): Promise<void>;
  /** Consume jobs (worker role). */
  work(handler: RunJobHandler, opts: { concurrency: number }): Promise<void>;
  stop(): Promise<void>;
}

type Log = { warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };

export const RUN_QUEUE = 'adminforge.runs';

/** pg-boss 12 queue. */
export class PgBossRunQueue implements RunQueue {
  readonly kind = 'pg-boss' as const;
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly log?: Log,
  ) {}

  private ensure(): Promise<PgBoss> {
    if (this.boss) return Promise.resolve(this.boss);
    this.starting ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.connectionString,
        application_name: 'adminforge-runs',
        max: 4,
      });
      boss.on('error', (err: unknown) =>
        this.log?.warn({ err: { message: (err as Error)?.message } }, 'pg-boss error'),
      );
      await boss.start();
      if (!(await boss.getQueue(RUN_QUEUE))) {
        try {
          await boss.createQueue(RUN_QUEUE, {
            policy: 'stately',
            retryLimit: 50,
            retryDelay: 5,
            retryBackoff: true,
            retryDelayMax: 300,
            // A run may take up to 4 h of active time; dead workers are detected by heartbeats instead.
            expireInSeconds: 5 * 3600,
            heartbeatSeconds: 60,
            deleteAfterSeconds: 7 * 86_400,
          });
        } catch (err) {
          if (!(await boss.getQueue(RUN_QUEUE))) throw err;
        }
      }
      this.boss = boss;
      return boss;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async start(): Promise<void> {
    await this.ensure();
  }

  async enqueue(runId: string, opts: { startAfter?: Date } = {}): Promise<void> {
    const boss = await this.ensure();
    await boss.send(
      RUN_QUEUE,
      { runId },
      { singletonKey: runId, ...(opts.startAfter ? { startAfter: opts.startAfter } : {}) },
    );
  }

  async work(handler: RunJobHandler, opts: { concurrency: number }): Promise<void> {
    const boss = await this.ensure();
    await boss.work<{ runId: string }>(
      RUN_QUEUE,
      { localConcurrency: Math.max(1, opts.concurrency), batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await handler(job.data.runId, job.signal);
      },
    );
  }

  async stop(): Promise<void> {
    const boss = this.boss ?? (this.starting ? await this.starting.catch(() => null) : null);
    this.boss = null;
    await boss?.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
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
  private stopped = false;
  /** Errors from handlers (tests assert none). */
  readonly errors: unknown[] = [];

  constructor(
    private readonly log?: Log,
    private readonly retryDelayMs = 50,
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
        try {
          await this.handler!(runId, new AbortController().signal);
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

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.state.values()) if (s.timer) clearTimeout(s.timer);
    await Promise.allSettled([...this.inflight]);
  }
}
