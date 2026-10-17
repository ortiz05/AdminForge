import pg from 'pg';
import { connectionConfig } from '../db/client';

/**
 * Single active scheduler (R6): leader election with a Postgres session-level advisory lock held on a dedicated
 * connection. The leader re-checks its connection every interval; if the connection drops, Postgres releases the lock
 * and a standby acquires it on its next attempt. Standbys retry every interval.
 */

export interface LeaderLock {
  /** True when this process now holds the lock. */
  tryAcquire(): Promise<boolean>;
  /** True while the lock is still held (the connection is alive). */
  check(): Promise<boolean>;
  release(): Promise<void>;
}

/** Timer seam for tests (fake clocks). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

type Log = { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export interface LeaderOptions {
  /** How often standbys try to acquire and the leader re-checks (default 5 s). */
  intervalMs?: number;
  timers?: Timers;
  log?: Log;
  onElected?: () => void | Promise<void>;
  onDemoted?: (reason: string) => void | Promise<void>;
}

export class LeaderElector {
  private leader = false;
  private running = false;
  private timer: unknown = null;
  private busy: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly timers: Timers;

  constructor(
    private readonly lock: LeaderLock,
    private readonly opts: LeaderOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.timers = opts.timers ?? realTimers;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  /** Starts campaigning (resolves after the first attempt). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.step();
  }

  /** One election step (also what the timer runs). */
  step(): Promise<void> {
    this.busy ??= this.attempt().finally(() => {
      this.busy = null;
      this.schedule();
    });
    return this.busy;
  }

  private schedule() {
    if (!this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.step();
    }, this.intervalMs);
  }

  private async attempt(): Promise<void> {
    if (!this.running) return;
    if (!this.leader) {
      let won = false;
      try {
        won = await this.lock.tryAcquire();
      } catch (err) {
        this.opts.log?.warn(
          { err: { message: (err as Error).message } },
          'scheduler: leader election attempt failed',
        );
      }
      if (won && this.running) {
        this.leader = true;
        this.opts.log?.info?.({}, 'scheduler: elected leader');
        await this.opts.onElected?.();
      } else if (won) await this.lock.release().catch(() => undefined);
      return;
    }
    const held = await this.lock.check().catch(() => false);
    if (!held) await this.demote('lost the scheduler lock (database connection dropped)');
  }

  private async demote(reason: string) {
    if (!this.leader) return;
    this.leader = false;
    this.opts.log?.warn({ reason }, 'scheduler: no longer the leader');
    await this.lock.release().catch(() => undefined);
    await this.opts.onDemoted?.(reason);
  }

  /** Stops campaigning; the leader releases the lock so a standby takes over at once. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.busy?.catch(() => undefined);
    await this.demote('shutting down');
  }
}

/** Lock key: pg_try_advisory_lock(hashtext('adminforge.scheduler')). */
export const SCHEDULER_LOCK_NAME = 'adminforge.scheduler';

/** The advisory lock on a dedicated connection (never from the pool: session locks belong to one connection). */
export function pgAdvisoryLock(url: string, name = SCHEDULER_LOCK_NAME): LeaderLock {
  let client: pg.Client | null = null;
  let broken = false;
  const drop = async () => {
    const c = client;
    client = null;
    if (c) {
      c.removeAllListeners();
      c.on('error', () => undefined);
      await c.end().catch(() => undefined);
    }
  };
  const connect = async () => {
    if (client && !broken) return client;
    await drop();
    broken = false;
    const c = new pg.Client(connectionConfig(url, { name: 'scheduler-lock' }));
    c.on('error', () => {
      broken = true;
    });
    c.on('end', () => {
      broken = true;
    });
    await c.connect();
    client = c;
    return c;
  };
  return {
    async tryAcquire() {
      const c = await connect();
      const r = await c.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [name]);
      if (!r.rows[0]?.ok) await drop();
      return r.rows[0]?.ok === true;
    },
    async check() {
      if (!client || broken) return false;
      try {
        await client.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      if (client && !broken)
        await client.query('select pg_advisory_unlock(hashtext($1))', [name]).catch(() => undefined);
      await drop();
    },
  };
}

/** No database: this process is always the scheduler (tests, DB-less mock mode). */
export const alwaysLeader = (): LeaderLock => ({
  tryAcquire: async () => true,
  check: async () => true,
  release: async () => undefined,
});
