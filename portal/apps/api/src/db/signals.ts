import type BetterSqlite3 from 'better-sqlite3';

/**
 * Cross-process notifications over the `signals` table (ADR-016; replaces Postgres LISTEN/NOTIFY). `publish` delivers to
 * this process's listeners at once and inserts a row; other processes using the same file (the CLI's `publish`, a
 * scheduler one-shot) see it on their next poll. Polling is cheap: `PRAGMA data_version` only changes when another
 * connection committed something, and only then are new rows read.
 *
 * Rows are kept for an hour (`prune`, from housekeeping). A process that fell further behind than that — or whose next
 * row id is not the one it expected — gets `onResync`, the equivalent of a LISTEN reconnect: drop caches and reload.
 */
export type SignalListener = (payload: string) => void;

export interface SignalsOptions {
  /** This process's id in `signals.origin` (its own rows are delivered in-process and skipped by its poller). */
  origin: string;
  /** Poll for other processes' rows (default true). */
  poll?: boolean;
  /** Read-only connections never insert (publish delivers in-process only). */
  readonly?: boolean;
  intervalMs?: number;
  /** Timer seam for tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;
const PAGE = 500;
export const SIGNAL_RETENTION_MS = 3_600_000;

export class Signals {
  private readonly listeners = new Map<string, Set<SignalListener>>();
  private readonly resync = new Set<() => void>();
  private timer: unknown = null;
  private lastId = 0;
  private dataVersion: number | null = null;
  private started = false;

  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    private readonly opts: SignalsOptions,
  ) {}

  get origin(): string {
    return this.opts.origin;
  }

  /** Subscribes to one channel (starts polling on first use). */
  on(channel: string, listener: SignalListener): () => void {
    if (!CHANNEL.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    this.start();
    return () => set.delete(listener);
  }

  /** Called when rows may have been missed: listeners should drop what they cached and reload. */
  onResync(listener: () => void): () => void {
    this.resync.add(listener);
    return () => this.resync.delete(listener);
  }

  /**
   * Delivers in-process now (unless `local: false`) and records the signal for other processes. Either after the change
   * it announces has committed, or — with `local: false` — inside the same write transaction (the row then commits or
   * rolls back with the change), followed by `emitLocal` after the commit.
   */
  publish(channel: string, payload: string, opts: { local?: boolean } = {}): void {
    if (!CHANNEL.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
    if (opts.local !== false) this.deliver(channel, payload);
    if (this.opts.readonly) return;
    this.sqlite
      .prepare('insert into signals (channel, payload, origin, created_at) values (?, ?, ?, ?)')
      .run(channel, payload, this.opts.origin, Date.now());
  }

  /**
   * Delivers to this process's listeners only. With `publish(…, { local: false })` inside a write transaction, the row
   * commits together with the change it announces; call this once the transaction has committed.
   */
  emitLocal(channel: string, payload: string): void {
    this.deliver(channel, payload);
  }

  /** Starts polling (idempotent). The first poll only notes where the table ends: older rows are history. */
  start(): void {
    if (this.started || this.opts.poll === false) return;
    this.started = true;
    try {
      this.lastId = this.maxId();
      this.dataVersion = this.version();
    } catch {
      // No signals table yet (an unmigrated database): poll() retries.
    }
    const every = this.opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms).unref());
    this.timer = every(() => this.poll(), this.opts.intervalMs ?? 500);
  }

  /** One poll (the timer's job; tests call it directly). */
  poll(): void {
    let version: number;
    try {
      version = this.version();
    } catch {
      return;
    }
    if (version === this.dataVersion) return;
    this.dataVersion = version;
    try {
      for (;;) {
        const rows = this.sqlite
          .prepare('select id, channel, payload, origin from signals where id > ? order by id limit ?')
          .all(this.lastId, PAGE) as Array<{ id: number; channel: string; payload: string; origin: string }>;
        if (!rows.length) return;
        // Ids are handed out by the single writer in commit order: a jump means rows were pruned before we read them.
        if (rows[0]!.id !== this.lastId + 1 && this.lastId > 0) this.fireResync();
        for (const r of rows) {
          this.lastId = r.id;
          if (r.origin !== this.opts.origin) this.deliver(r.channel, r.payload);
        }
        if (rows.length < PAGE) return;
      }
    } catch {
      // A busy or closing database: the next poll catches up (data_version will still differ).
      this.dataVersion = null;
    }
  }

  /** Deletes rows older than the retention window (housekeeping). */
  prune(now = new Date()): number {
    if (this.opts.readonly) return 0;
    return this.sqlite
      .prepare('delete from signals where created_at < ?')
      .run(now.getTime() - SIGNAL_RETENTION_MS).changes;
  }

  stop(): void {
    if (this.timer !== null)
      (this.opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    this.started = false;
    this.listeners.clear();
    this.resync.clear();
  }

  private version(): number {
    return this.sqlite.pragma('data_version', { simple: true }) as number;
  }

  private maxId(): number {
    const r = this.sqlite.prepare('select coalesce(max(id), 0) as id from signals').get() as { id: number };
    return r.id;
  }

  private deliver(channel: string, payload: string) {
    for (const l of this.listeners.get(channel) ?? []) {
      try {
        l(payload);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private fireResync() {
    for (const l of this.resync) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}
