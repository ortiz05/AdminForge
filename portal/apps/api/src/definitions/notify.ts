import pg from 'pg';

export interface ListenerOptions {
  /** Called after every (re)connect: notifications sent while disconnected are lost, so callers resync. */
  onConnect?: () => void;
  log?: { warn(obj: object, msg: string): void };
  /** Max reconnect delay (default 30 s). */
  maxDelayMs?: number;
}

/**
 * A dedicated Postgres connection that LISTENs on one channel and reconnects with backoff (ADR-004: LISTEN/NOTIFY
 * invalidates caches across API replicas). The connection string is never logged.
 */
export class PgListener {
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly channel: string,
    private readonly onMessage: (payload: string) => void,
    private readonly opts: ListenerOptions = {},
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
  }

  /** Connects (resolves once listening, or after the first failure — reconnects continue in the background). */
  start(): Promise<void> {
    this.stopped = false;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.url, connectionTimeoutMillis: 5_000 });
    const retry = () => {
      if (this.client === client) this.client = null;
      client.removeAllListeners();
      client.on('error', () => undefined);
      client.end().catch(() => undefined);
      this.schedule();
    };
    client.on('error', (err) => {
      this.opts.log?.warn({ err: { message: err.message } }, `LISTEN ${this.channel}: connection error; reconnecting`);
      retry();
    });
    client.on('end', () => {
      if (!this.stopped && this.client === client) retry();
    });
    client.on('notification', (msg) => {
      if (msg.channel === this.channel) this.onMessage(msg.payload ?? '');
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${this.channel}`);
      if (this.stopped) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.attempt = 0;
      this.opts.onConnect?.();
    } catch (err) {
      this.opts.log?.warn({ err: { message: (err as Error).message } }, `LISTEN ${this.channel}: cannot connect; retrying`);
      retry();
    }
  }

  private schedule() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(1000 * 2 ** this.attempt++, this.opts.maxDelayMs ?? 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start();
    }, delay);
    this.timer.unref?.();
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      c.on('error', () => undefined);
      await c.end().catch(() => undefined);
    }
  }
}
