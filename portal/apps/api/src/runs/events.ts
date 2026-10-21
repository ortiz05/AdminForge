import type { RunNotification } from './types';

type Listener = (n: RunNotification) => void;

/**
 * Fan-out of run notifications inside the process: SSE streams subscribe per run, the worker subscribes to everything
 * (cancellation). The repository dispatches here directly when it records an event (`onNotify`): the worker and every
 * stream live in the API process (ADR-016).
 */
export class RunEventBus {
  private readonly byRun = new Map<string, Set<Listener>>();
  private readonly all = new Set<Listener>();

  private readonly streams = new Set<() => void>();

  /** Registers an open stream (SSE) to be closed on shutdown. */
  track(close: () => void): () => void {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  async stop(): Promise<void> {
    for (const close of [...this.streams]) close();
    this.streams.clear();
    this.byRun.clear();
    this.all.clear();
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
