/**
 * PowerShell runner slots per signed-in person (RUNNER_JOBS_PER_PERSON). The runner has a few workers for everyone;
 * without a share, one person's pages, exports and playbook steps could hold them all while everyone else's jobs wait
 * until they time out (2026-10-22 review). One process-wide counter for both paths: a datasource read is refused when
 * the person's slots are full (`tryTake`); a playbook step waits for one of their own slots to free up (`take`). The
 * automation identity isn't counted here (the runner's own queue bounds it).
 */
export class RunnerSlots {
  private readonly held = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  /** A slot for `who`, or null when they already hold `limit`. Call the returned function to give it back. */
  tryTake(who: string, limit: number): (() => void) | null {
    if ((this.held.get(who) ?? 0) >= limit) return null;
    this.held.set(who, (this.held.get(who) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(who);
    };
  }

  /** Waits for a slot for `who` (first come, first served among their own jobs); rejects when `signal` aborts. */
  async take(who: string, limit: number, signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      const slot = this.tryTake(who, limit);
      if (slot) return slot;
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting.get(who) ?? [];
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const q = this.waiting.get(who);
          if (q) q.splice(q.indexOf(wake), 1);
          reject(signal?.reason ?? new Error('aborted'));
        };
        queue.push(wake);
        this.waiting.set(who, queue);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private release(who: string): void {
    const n = (this.held.get(who) ?? 1) - 1;
    if (n > 0) this.held.set(who, n);
    else this.held.delete(who);
    const queue = this.waiting.get(who);
    const next = queue?.shift();
    if (queue && !queue.length) this.waiting.delete(who);
    next?.();
  }
}

/** The process's runner slots (one API process per installation, ADR-016). */
export const runnerSlots = new RunnerSlots();
