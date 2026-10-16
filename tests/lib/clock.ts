/**
 * The test clocks — one module so every project pins time the same way (2026-10-15 12:00 UTC by default).
 *
 * - `Clock`: a settable `now()` for code that takes an injected `now` (the API apps in tests/api: sessions, audit,
 *   runs). `advance(ms)` moves it forward; tests may also set `t` directly.
 * - `FakeClock`: the same clock plus the scheduler's `Timers` port, so `setTimeout` callbacks fire as the clock is
 *   advanced (the scheduler, leader election and in-process schedules in unit/scheduler and tests/api). Its
 *   `advance(ms)` is async — it awaits microtasks between due timers — but with no timer due it moves `t`
 *   synchronously before its first `await`, exactly like `Clock.advance`.
 *
 * Imported by tests/api/helpers.ts (re-exported as `Clock`) and tests/support/scheduler.ts (re-exported as
 * `FakeClock`); tests take it from there.
 */
import type { Timers } from '@adminforge/api/src/schedules/leader';

/** Default start time of every test clock. */
export const TEST_EPOCH = Date.parse('2026-10-15T12:00:00.000Z');

/** Controllable clock: `now()` returns `t`, which only moves when a test moves it. */
export class Clock {
  constructor(public t = TEST_EPOCH) {}
  now = () => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A controllable clock plus timers driven by it (setTimeout callbacks fire as the clock advances). */
export class FakeClock extends Clock implements Timers {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.t + Math.max(ms, 0), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Moves the clock forward, firing due timers in order (awaiting microtasks between them). */
  override async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, p]) => p.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
  /** Timers still waiting to fire. */
  get timers(): number {
    return this.pending.size;
  }
}

/** Lets queued promise callbacks and immediates run (20 turns of the event loop). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}
