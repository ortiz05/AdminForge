import type { Clock } from './ports';

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wall clock with real timers. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: abortable,
  timer: abortable,
};

/**
 * Virtual clock for tests and content tests: `sleep` advances virtual time instantly (backoff costs nothing),
 * `timer` resolves only when virtual time reaches its deadline (via `advance`/`set`/`sleep`), so step timeouts are
 * deterministic.
 */
export class VirtualClock implements Clock {
  private t: number;
  private timers: Array<{ at: number; resolve: () => void }> = [];
  /** Every sleep requested, in ms (assert backoff schedules). */
  readonly sleeps: number[] = [];

  constructor(start: Date | string | number = '2026-10-15T12:00:00.000Z') {
    this.t = new Date(start).getTime();
  }

  now = (): Date => new Date(this.t);

  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    this.sleeps.push(ms);
    this.advance(ms);
    await Promise.resolve();
  };

  timer = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const entry = { at: this.t + Math.max(0, ms), resolve };
      this.timers.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((x) => x !== entry);
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });

  /** Moves virtual time forward and fires due timers. */
  advance(ms: number): void {
    this.set(this.t + ms);
  }

  set(at: Date | number): void {
    this.t = Math.max(this.t, new Date(at).getTime());
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.resolve();
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}
