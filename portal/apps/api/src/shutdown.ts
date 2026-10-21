/**
 * Stopping the API process (D-24). On SIGTERM (Kubernetes) or SIGINT the app closes — the run worker's graceful stop
 * (runs stop at a checkpoint, their jobs are queued again), the scheduler, open streams, then the database — within
 * a deadline of its own (SHUTDOWN_TIMEOUT_SECONDS, default 50 s). The deadline is shorter than the pod's
 * `terminationGracePeriodSeconds` (60 s), so a stop that hangs ends with a log line naming what was still open and
 * exit code 1 instead of a silent SIGKILL. A second signal exits at once.
 */

type Log = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export interface ShutdownOptions {
  /** Closes the app (Fastify's `close()`: preClose and onClose hooks). */
  close: () => Promise<void>;
  deadlineMs: number;
  log: Log;
  /** What the app still has open (run ids in flight …), logged when the deadline passes. */
  pending?: () => Record<string, unknown>;
  exit: (code: number) => void;
}

/** Node's active handles and requests by type (sockets, timers, file operations) — what keeps the process up. */
function activeResources(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) out[name] = (out[name] ?? 0) + 1;
  return out;
}

/** The signal handler: the first signal closes the app within the deadline; a second one exits at once. */
export function onShutdownSignal(opts: ShutdownOptions): (signal: string) => void {
  const { log, exit, deadlineMs } = opts;
  let closing = false;
  return (signal) => {
    if (closing) {
      log.error({ signal }, 'second signal; exiting now');
      exit(1);
      return;
    }
    closing = true;
    log.info({ signal, deadlineMs }, 'shutting down');
    const deadline = setTimeout(() => {
      let open: Record<string, unknown> = {};
      try {
        open = { ...opts.pending?.(), resources: activeResources() };
      } catch {
        // Best effort: the exit matters more than the description.
      }
      log.error({ signal, deadlineMs, open }, 'shutdown did not finish in time; exiting');
      exit(1);
    }, deadlineMs);
    opts.close().then(
      () => {
        clearTimeout(deadline);
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(deadline);
        log.error({ signal, err: { message: (err as Error)?.message ?? String(err) } }, 'shutdown failed');
        exit(1);
      },
    );
  };
}
