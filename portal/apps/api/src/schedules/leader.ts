import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client';
import { Leases } from '../db/leases';

/**
 * Single active scheduler (R6): leader election with a lease in the database (`leases`, name `adminforge.scheduler`).
 * The leader renews it every interval; if it stops (the process died or hung), the lease expires and another process
 * using the same file takes it on its next attempt. There is normally one process (the API, ADR-016): the lease is
 * what keeps a second one — a misconfigured second pod, `pnpm dev` pointed at the same file — from running every
 * schedule twice.
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
    if (!held) await this.demote('lost the scheduler lease (it expired, or another process took it)');
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

export const SCHEDULER_LOCK_NAME = 'adminforge.scheduler';
/** How long a leader's lease lasts without renewal (renewed every election interval, 5 s by default). */
export const SCHEDULER_LEASE_MS = 30_000;

/** The scheduler's lease (one holder id per process lifetime of this lock). */
export function leaseLock(
  database: Pick<Database, 'sqlite' | 'signals'>,
  opts: { name?: string; ttlMs?: number; now?: () => number } = {},
): LeaderLock {
  const leases = new Leases(database.sqlite, opts.now);
  const name = opts.name ?? SCHEDULER_LOCK_NAME;
  const ttl = opts.ttlMs ?? SCHEDULER_LEASE_MS;
  const holder = `${database.signals.origin}:scheduler:${randomUUID()}`;
  return {
    tryAcquire: async () => leases.tryAcquire(name, holder, ttl),
    check: async () => leases.renew(name, holder, ttl),
    release: async () => leases.release(name, holder),
  };
}

/** No database: this process is always the scheduler (tests, DB-less mock mode). */
export const alwaysLeader = (): LeaderLock => ({
  tryAcquire: async () => true,
  check: async () => true,
  release: async () => undefined,
});
