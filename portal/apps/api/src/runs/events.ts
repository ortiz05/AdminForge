import { PgListener } from '../definitions/notify';
import { RUN_EVENTS_CHANNEL, type RunNotification } from './types';

type Listener = (n: RunNotification) => void;
type Log = { warn(obj: object, msg: string): void };

/**
 * Fan-out of `run_events` notifications inside one process: SSE streams subscribe per run, the worker subscribes to
 * everything (cancellation). With Postgres the notifications arrive through LISTEN (so every replica sees every run);
 * without it the in-memory repository dispatches directly.
 */
export class RunEventBus {
  private readonly byRun = new Map<string, Set<Listener>>();
  private readonly all = new Set<Listener>();
  private listener: PgListener | null = null;
  private readonly reconnectListeners = new Set<() => void>();

  constructor(opts: { listenUrl?: string; log?: Log } = {}) {
    if (opts.listenUrl) {
      let first = true;
      this.listener = new PgListener(
        opts.listenUrl,
        RUN_EVENTS_CHANNEL,
        (payload) => this.onPayload(payload),
        {
          log: opts.log,
          onConnect: () => {
            // Notifications sent while disconnected are lost: subscribers re-read from their last event id.
            if (!first) for (const l of this.reconnectListeners) l();
            first = false;
          },
        },
      );
    }
  }

  private started: Promise<void> | null = null;

  /** Starts LISTEN once (idempotent; safe to call from every subscriber). */
  start(): Promise<void> {
    this.started ??= this.listener?.start() ?? Promise.resolve();
    return this.started;
  }

  private readonly streams = new Set<() => void>();

  /** Registers an open stream (SSE) to be closed on shutdown. */
  track(close: () => void): () => void {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  async stop(): Promise<void> {
    this.started = null;
    for (const close of [...this.streams]) close();
    this.streams.clear();
    await this.listener?.stop();
    this.byRun.clear();
    this.all.clear();
    this.reconnectListeners.clear();
  }

  private onPayload(payload: string) {
    try {
      const n = JSON.parse(payload) as RunNotification;
      if (n && typeof n.runId === 'string') this.dispatch(n);
    } catch {
      // ignore malformed payloads
    }
  }

  dispatch(n: RunNotification): void {
    for (const l of this.byRun.get(n.runId) ?? []) safe(l, n);
    for (const l of this.all) safe(l, n);
  }

  /** `runId` = one run; `*` = every run. Returns the unsubscribe function. */
  subscribe(runId: string, listener: Listener): () => void {
    if (runId === '*') {
      this.all.add(listener);
      return () => this.all.delete(listener);
    }
    let set = this.byRun.get(runId);
    if (!set) this.byRun.set(runId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.byRun.delete(runId);
    };
  }

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  get listenerCount(): number {
    let n = this.all.size;
    for (const s of this.byRun.values()) n += s.size;
    return n;
  }
}

function safe(l: Listener, n: RunNotification) {
  try {
    l(n);
  } catch {
    // a broken subscriber must not break the others
  }
}
