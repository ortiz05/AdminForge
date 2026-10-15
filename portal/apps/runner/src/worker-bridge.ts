import { type RunnerLogger, type PooledWorker, type WorkerExit } from './pool';
import {
  type RunnerEvent,
  type RunnerJobStatus,
  type WorkerJobPayload,
  parseWorkerLine,
  truncate,
} from './protocol';
import type { Redactor } from './redact';

export interface RunOnWorkerOptions {
  worker: PooledWorker;
  payload: WorkerJobPayload;
  timeoutMs: number;
  /** Aborting kills the worker; the abort reason (string) is shown in the error event. */
  signal: AbortSignal;
  redact: Redactor;
  emit: (event: RunnerEvent) => void;
  logger: RunnerLogger;
  maxOutputBytes?: number;
  maxStderrLines?: number;
  /** How long a worker may linger after reporting `exit` before it is killed. */
  exitGraceMs?: number;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Hands one job to a worker over stdin and relays its events. Every line from the worker is redacted with
 * the job's redactor before it is parsed, streamed, or logged. Resolves once the worker process is gone.
 */
export function runJobOnWorker(opts: RunOnWorkerOptions): Promise<{ status: RunnerJobStatus }> {
  const { worker, emit, redact, logger } = opts;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrLines = opts.maxStderrLines ?? 200;
  const jobId = opts.payload.jobId;

  return new Promise((resolve) => {
    let exitStatus: 'succeeded' | 'failed' | undefined;
    let stopReason: { kind: 'timeout' | 'cancelled' | 'protocol'; message: string } | undefined;
    let outputChars = 0;
    let stderrLines = 0;
    let graceTimer: NodeJS.Timeout | undefined;

    const stop = (kind: 'timeout' | 'cancelled' | 'protocol', message: string) => {
      if (!exitStatus && !stopReason) stopReason = { kind, message };
      worker.kill();
    };

    const onStdout = (line: string) => {
      outputChars += line.length + 1;
      if (outputChars > maxOutputBytes) {
        stop(
          'protocol',
          `The script produced more than ${Math.round(maxOutputBytes / 1024 / 1024)} MiB of output; the worker was stopped`,
        );
        return;
      }
      const message = parseWorkerLine(redact(line));
      if (!message || message.type === 'ready' || stopReason) return;
      if (message.type === 'exit') {
        exitStatus = message.status;
        graceTimer = setTimeout(() => worker.kill(), opts.exitGraceMs ?? 10_000);
        graceTimer.unref();
        return;
      }
      emit(message);
    };

    const onStderr = (line: string) => {
      const text = redact(line).trimEnd();
      if (!text || stopReason) return;
      logger.debug({ jobId, workerPid: worker.pid }, `worker stderr: ${truncate(text, 2000)}`);
      stderrLines++;
      if (stderrLines <= maxStderrLines)
        emit({ type: 'log', level: 'warn', message: truncate(text), ts: new Date().toISOString() });
      else if (stderrLines === maxStderrLines + 1)
        emit({
          type: 'log',
          level: 'warn',
          message: 'Further stderr output was suppressed',
          ts: new Date().toISOString(),
        });
    };

    const onOverflow = () =>
      stop('protocol', 'The script wrote a single output line larger than 8 MiB; the worker was stopped');

    const onAbort = () => {
      const reason = opts.signal.reason;
      stop('cancelled', `The job was cancelled${typeof reason === 'string' && reason ? ` (${reason})` : ''}`);
    };

    const timer = setTimeout(
      () =>
        stop(
          'timeout',
          `The job exceeded its ${Math.round(opts.timeoutMs / 1000)} s timeout and was stopped`,
        ),
      opts.timeoutMs,
    );
    timer.unref();

    const onClose = (exit: WorkerExit) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal.removeEventListener('abort', onAbort);
      worker.off('stdout-line', onStdout);
      worker.off('stderr-line', onStderr);
      worker.off('overflow', onOverflow);
      let status: RunnerJobStatus;
      if (exitStatus) {
        status = exitStatus;
      } else if (stopReason) {
        const { kind, message } = stopReason;
        emit({ type: 'error', message, category: kind });
        status = kind === 'protocol' ? 'failed' : kind;
      } else {
        const detail =
          worker.spawnError ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
        emit({
          type: 'error',
          message: redact(`The runner worker exited unexpectedly (${detail})`),
          category: 'runner',
        });
        status = 'failed';
      }
      resolve({ status });
    };

    worker.on('stdout-line', onStdout);
    worker.on('stderr-line', onStderr);
    worker.on('overflow', onOverflow);
    worker.once('close', onClose);
    if (worker.state === 'exited') {
      onClose({ code: null, signal: null });
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    worker.writeJob(JSON.stringify(opts.payload));
  });
}
