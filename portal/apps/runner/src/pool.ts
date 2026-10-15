import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { WorkerCommand } from './config';
import { type WorkerReadyInfo, parseWorkerLine, truncate } from './protocol';
import { redactGeneric } from './redact';

/** The subset of a pino/Fastify logger the runner uses. */
export interface RunnerLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLogger: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Splits a byte stream into lines without rescanning the buffer (large output lines stay linear). */
export class LineSplitter {
  private buffer = '';
  private scanned = 0;
  private overflowed = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars: number,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer | string): void {
    if (this.overflowed) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    let newline = this.buffer.indexOf('\n', this.scanned);
    while (newline !== -1) {
      this.onLine(this.buffer.slice(start, newline).replace(/\r$/, ''));
      start = newline + 1;
      newline = this.buffer.indexOf('\n', start);
    }
    this.buffer = this.buffer.slice(start);
    this.scanned = this.buffer.length;
    if (this.buffer.length > this.maxLineChars) {
      this.overflowed = true;
      this.buffer = '';
      this.onOverflow();
    }
  }

  end(): void {
    if (this.overflowed) return;
    this.buffer += this.decoder.end();
    if (this.buffer) this.onLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
  }
}

export type WorkerState = 'starting' | 'ready' | 'busy' | 'exited';
export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/**
 * One single-use pwsh process. Emits 'stdout-line', 'stderr-line', 'overflow' and finally 'close' (WorkerExit)
 * after its stdio has drained.
 */
export class PooledWorker extends EventEmitter {
  state: WorkerState = 'starting';
  readyInfo: WorkerReadyInfo | undefined;
  spawnError: string | undefined;
  readonly exited: Promise<WorkerExit>;
  private readonly stderrTail: string[] = [];
  private finished = false;

  constructor(
    readonly id: number,
    readonly child: ChildProcess,
    readonly home: string | undefined,
  ) {
    super();
    let resolveExit!: (exit: WorkerExit) => void;
    this.exited = new Promise((resolve) => (resolveExit = resolve));
    const overflow = () => this.emit('overflow');
    const out = new LineSplitter((line) => this.emit('stdout-line', line), MAX_LINE_CHARS, overflow);
    const err = new LineSplitter(
      (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.emit('stderr-line', line);
      },
      64 * 1024,
      () => {},
    );
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stdout?.on('end', () => out.end());
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.stderr?.on('end', () => err.end());
    child.stdin?.on('error', () => {}); // EPIPE when the worker died; the 'close' handler reports it
    const finish = (exit: WorkerExit) => {
      if (this.finished) return;
      this.finished = true;
      this.state = 'exited';
      this.emit('close', exit);
      resolveExit(exit);
    };
    child.on('error', (error) => {
      this.spawnError = error.message;
      if (child.pid === undefined) finish({ code: null, signal: null });
    });
    child.on('close', (code, signal) => finish({ code, signal }));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Last stderr lines (already generic-redacted) for diagnostics. */
  stderrSummary(): string {
    return redactGeneric(this.stderrTail.join('\n')).trim();
  }

  /** Writes the job and closes stdin: a worker reads exactly one line. */
  writeJob(line: string): void {
    this.child.stdin?.end(line.endsWith('\n') ? line : `${line}\n`);
  }

  /** Kills the whole process group (pwsh and anything a script started). */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.state === 'exited') return;
    try {
      if (this.child.pid !== undefined) process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }
}

export interface WorkerPoolOptions {
  command: WorkerCommand;
  /** Warm workers kept ready. */
  size: number;
  /** Jobs running at the same time. */
  maxJobs: number;
  readyTimeoutMs?: number;
  /** Give every worker a private, temporary HOME/TMPDIR that is deleted when it exits (default true). */
  isolateHome?: boolean;
  logger?: RunnerLogger;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface PoolStatus {
  size: number;
  maxJobs: number;
  ready: number;
  starting: number;
  busy: number;
  waiting: number;
  consecutiveFailures: number;
  lastError: string | null;
  closed: boolean;
}

export class PoolUnavailableError extends Error {
  override name = 'PoolUnavailableError';
}
export class PoolTimeoutError extends Error {
  override name = 'PoolTimeoutError';
}

interface Waiter {
  resolve(worker: PooledWorker): void;
  reject(error: Error): void;
  cleanup(): void;
}

const UNAVAILABLE_AFTER_FAILURES = 3;

/**
 * Pre-forks single-use workers. A worker serves exactly one job and is never returned to the pool;
 * taking a worker immediately starts its replacement. Startup failures back off exponentially.
 */
export class WorkerPool {
  private readonly workers = new Set<PooledWorker>();
  private readonly idle: PooledWorker[] = [];
  private readonly waiters: Waiter[] = [];
  private failures = 0;
  private lastError: string | null = null;
  private refillTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private nextId = 1;
  private readonly log: RunnerLogger;
  /** Ready info of the most recent worker (pwsh version, loaded modules). */
  lastReady: WorkerReadyInfo | undefined;

  constructor(private readonly opts: WorkerPoolOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  start(): void {
    this.refill();
  }

  private count(state: WorkerState): number {
    let n = 0;
    for (const w of this.workers) if (w.state === state) n++;
    return n;
  }

  status(): PoolStatus {
    return {
      size: this.opts.size,
      maxJobs: this.opts.maxJobs,
      ready: this.idle.length,
      starting: this.count('starting'),
      busy: this.count('busy'),
      waiting: this.waiters.length,
      consecutiveFailures: this.failures,
      lastError: this.lastError,
      closed: this.closed,
    };
  }

  /** True when no worker can be expected soon (closed, or repeated startup failures and nothing warm). */
  isUnavailable(): boolean {
    return this.closed || (this.idle.length === 0 && this.failures >= UNAVAILABLE_AFTER_FAILURES);
  }

  /** Takes a warm worker (waiting up to timeoutMs). The worker is the caller's until it exits. */
  acquire(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<PooledWorker> {
    if (this.isUnavailable()) return Promise.reject(new PoolUnavailableError(this.unavailableMessage()));
    if (opts.signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<PooledWorker>((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(waiter);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(
          new PoolTimeoutError(
            `No runner worker became available within ${Math.round(opts.timeoutMs / 1000)} s`,
          ),
        );
      }, opts.timeoutMs);
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        },
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.serveWaiters();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.refillTimer);
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(new PoolUnavailableError('The runner is shutting down'));
    }
    const all = [...this.workers];
    for (const w of all) w.kill();
    await Promise.race([
      Promise.all(all.map((w) => w.exited)),
      new Promise((r) => setTimeout(r, 5000).unref()),
    ]);
  }

  private unavailableMessage(): string {
    if (this.closed) return 'The runner is shutting down';
    return `Runner workers fail to start${this.lastError ? `: ${this.lastError}` : ''}`;
  }

  private removeWaiter(waiter: Waiter): void {
    const i = this.waiters.indexOf(waiter);
    if (i !== -1) this.waiters.splice(i, 1);
    waiter.cleanup();
  }

  private serveWaiters(): void {
    while (this.waiters.length && this.idle.length && this.count('busy') < this.opts.maxJobs) {
      const worker = this.idle.shift()!;
      if (worker.state !== 'ready') continue;
      const waiter = this.waiters.shift()!;
      waiter.cleanup();
      worker.state = 'busy';
      waiter.resolve(worker);
    }
    this.refill();
  }

  private refill(): void {
    if (this.closed || this.refillTimer) return;
    const starting = this.count('starting');
    const ready = this.idle.length;
    const busy = this.count('busy');
    const wanted = Math.min(
      this.opts.size - (starting + ready),
      this.opts.size + this.opts.maxJobs - (starting + ready + busy),
    );
    if (wanted <= 0) return;
    if (this.failures > 0) {
      // Probe with one worker at a time until one comes up.
      if (starting > 0) return;
      const base = this.opts.backoffBaseMs ?? 500;
      const delay = Math.min(this.opts.backoffMaxMs ?? 30_000, base * 2 ** (this.failures - 1));
      this.refillTimer = setTimeout(() => {
        this.refillTimer = undefined;
        if (!this.closed) this.spawnWorker();
      }, delay);
      this.refillTimer.unref();
      return;
    }
    for (let i = 0; i < wanted; i++) this.spawnWorker();
  }

  private spawnWorker(): void {
    const { command } = this.opts;
    const isolate = this.opts.isolateHome ?? true;
    const home = isolate ? mkdtempSync(path.join(tmpdir(), 'adminforge-worker-')) : undefined;
    const env = home
      ? { ...command.env, HOME: home, TMPDIR: home, TMP: home, TEMP: home }
      : { ...command.env };
    let child: ChildProcess;
    try {
      child = spawn(command.command, command.args, {
        env,
        cwd: home,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      if (home) rmSync(home, { recursive: true, force: true });
      this.onStartFailure(`Could not start ${command.command}: ${(error as Error).message}`);
      return;
    }
    const worker = new PooledWorker(this.nextId++, child, home);
    this.workers.add(worker);
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? 120_000;
    const readyTimer = setTimeout(() => {
      if (worker.state !== 'starting') return;
      this.lastError = `Worker did not become ready within ${Math.round(readyTimeoutMs / 1000)} s`;
      worker.kill();
    }, readyTimeoutMs);
    readyTimer.unref();

    const onStartupLine = (line: string) => {
      if (worker.state !== 'starting') return;
      const message = parseWorkerLine(redactGeneric(line));
      if (message?.type === 'ready') {
        clearTimeout(readyTimer);
        worker.state = 'ready';
        worker.readyInfo = message.info;
        this.lastReady = message.info;
        this.failures = 0;
        this.lastError = null;
        this.idle.push(worker);
        this.log.debug({ worker: worker.id, workerPid: worker.pid }, 'runner worker ready');
        this.serveWaiters();
      } else if (message) {
        this.log.debug({ worker: worker.id }, `worker startup output: ${truncate(line, 500)}`);
      }
    };
    worker.on('stdout-line', onStartupLine);
    worker.once('close', (exit: WorkerExit) => {
      clearTimeout(readyTimer);
      worker.off('stdout-line', onStartupLine);
      const wasStarting = !worker.readyInfo;
      this.workers.delete(worker);
      const i = this.idle.indexOf(worker);
      if (i !== -1) this.idle.splice(i, 1);
      if (home) rmSync(home, { recursive: true, force: true });
      if (wasStarting && !this.closed) {
        const detail =
          worker.spawnError ?? (worker.stderrSummary() || `exit code ${exit.code ?? exit.signal}`);
        this.onStartFailure(
          this.lastError && this.lastError.startsWith('Worker did not become ready')
            ? this.lastError
            : `Worker exited before it was ready: ${truncate(detail, 1000)}`,
        );
      } else if (i !== -1 && !this.closed) {
        this.log.warn(
          { worker: worker.id, code: exit.code, signal: exit.signal },
          'idle runner worker exited; replacing it',
        );
      }
      this.serveWaiters();
    });
  }

  private onStartFailure(message: string): void {
    this.failures++;
    this.lastError = message;
    this.log.warn({ failures: this.failures }, `runner worker failed to start: ${message}`);
    if (this.isUnavailable()) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.cleanup();
        waiter.reject(new PoolUnavailableError(this.unavailableMessage()));
      }
    }
    this.refill();
  }
}
