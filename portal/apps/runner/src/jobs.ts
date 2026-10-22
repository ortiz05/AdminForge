import { type RunnerLogger, type WorkerPool, PoolUnavailableError } from './pool';
import type { RunnerEvent, RunnerJob, RunnerJobStatus, WorkerJobPayload } from './protocol';
import { createRedactor } from './redact';
import { type ResolvedScript, ScriptError, resolveScript } from './scripts';
import { runJobOnWorker } from './worker-bridge';

/** A job the runner refused before starting it (maps to a non-200 HTTP answer). */
export class JobRejectedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobRejectedError';
  }
}

export interface AdmittedJob {
  job: RunnerJob;
  script: ResolvedScript;
  controller: AbortController;
}

export interface JobManagerOptions {
  pool: WorkerPool;
  scriptsDir: string;
  queueTimeoutMs: number;
  /** Jobs that may wait for a worker at once; one more is refused (503 runner_busy). Default: unbounded. */
  maxWaiting?: number;
  logger: RunnerLogger;
  /** Job ids are remembered this long after they finish so a replayed request cannot run a job twice. */
  recentTtlMs?: number;
}

export class JobManager {
  private readonly running = new Map<string, AbortController>();
  /** Admitted jobs that haven't got a worker yet (counted from admission, so simultaneous requests can't overshoot). */
  private waiting = 0;
  private readonly recent = new Map<string, number>();

  constructor(private readonly opts: JobManagerOptions) {}

  get runningCount(): number {
    return this.running.size;
  }

  /** Validates a job (unique id, runner available, pinned script + sha256) and reserves its id. */
  async admit(job: RunnerJob): Promise<AdmittedJob> {
    this.prune();
    if (this.running.has(job.jobId) || this.recent.has(job.jobId)) {
      throw new JobRejectedError(409, 'duplicate_job', `Job ${job.jobId} was already submitted`);
    }
    if (this.opts.pool.isUnavailable()) {
      throw new JobRejectedError(
        503,
        'runner_unavailable',
        'No runner worker is available (see GET /healthz)',
      );
    }
    // A bounded queue: past it a job is refused at once (the API retries a 503 as transient) rather than waiting
    // behind everyone else's until it times out (2026-10-22 review).
    if (this.opts.maxWaiting !== undefined && this.waiting >= this.opts.maxWaiting) {
      throw new JobRejectedError(
        503,
        'runner_busy',
        `Every runner worker is busy and ${this.waiting} jobs are already waiting`,
      );
    }
    if (job.tokens.sharepointAdmin && !job.tenant.spoTenantName) {
      throw new JobRejectedError(
        400,
        'invalid_request',
        'tenant.spoTenantName is required when a sharepointAdmin token is sent',
      );
    }
    const controller = new AbortController();
    this.running.set(job.jobId, controller);
    this.waiting++;
    try {
      const script = await resolveScript(this.opts.scriptsDir, job.script.path, job.script.sha256);
      return { job, script, controller };
    } catch (error) {
      this.waiting--;
      this.running.delete(job.jobId);
      if (error instanceof ScriptError)
        throw new JobRejectedError(error.statusCode, error.code, error.message);
      throw error;
    }
  }

  /** Runs an admitted job. Emits `accepted` first and `done` last, whatever happens in between. */
  async run(admitted: AdmittedJob, emit: (event: RunnerEvent) => void): Promise<RunnerJobStatus> {
    const { job, script, controller } = admitted;
    const started = Date.now();
    const redact = createRedactor(Object.values(job.tokens));
    const log = this.opts.logger;
    let status: RunnerJobStatus = 'failed';
    emit({ type: 'accepted', jobId: job.jobId });
    try {
      let worker;
      try {
        worker = await this.opts.pool
          .acquire({
            timeoutMs: this.opts.queueTimeoutMs,
            signal: controller.signal,
          })
          .finally(() => this.waiting--);
      } catch (error) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          emit({
            type: 'error',
            message: `The job was cancelled${typeof reason === 'string' ? ` (${reason})` : ''}`,
            category: 'cancelled',
          });
          status = 'cancelled';
        } else {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: 'error', message: redact(message), category: 'runner' });
          status = 'failed';
          if (!(error instanceof PoolUnavailableError))
            log.warn({ jobId: job.jobId }, `no worker for job: ${redact(message)}`);
        }
        return status;
      }
      log.info(
        {
          jobId: job.jobId,
          script: script.path,
          mode: job.mode,
          workerPid: worker.pid,
          services: Object.keys(job.tokens),
        },
        'job started',
      );
      const payload: WorkerJobPayload = {
        jobId: job.jobId,
        mode: job.mode,
        script: { path: script.path, sha256: script.sha256, content: script.content },
        inputs: job.inputs,
        tokens: job.tokens,
        tenant: job.tenant,
        timeoutSeconds: job.timeoutSeconds,
      };
      const result = await runJobOnWorker({
        worker,
        payload,
        timeoutMs: job.timeoutSeconds * 1000,
        signal: controller.signal,
        redact,
        emit,
        logger: log,
      });
      status = result.status;
      return status;
    } finally {
      this.running.delete(job.jobId);
      this.recent.set(job.jobId, Date.now() + (this.opts.recentTtlMs ?? 10 * 60_000));
      const durationMs = Date.now() - started;
      emit({ type: 'done', status, durationMs });
      log.info({ jobId: job.jobId, script: script.path, mode: job.mode, status, durationMs }, 'job finished');
    }
  }

  /** Cancels a running (or still queued) job. Returns false for unknown ids. */
  cancel(jobId: string, reason: string): boolean {
    const controller = this.running.get(jobId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  cancelAll(reason: string): void {
    for (const controller of this.running.values()) controller.abort(reason);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, expires] of this.recent) if (expires <= now) this.recent.delete(id);
  }
}
