import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type PooledWorker,
  PoolTimeoutError,
  PoolUnavailableError,
  WorkerPool,
} from '@adminforge/runner/src/pool';
import type { RunnerEvent, WorkerJobPayload } from '@adminforge/runner/src/protocol';
import { createRedactor } from '@adminforge/runner/src/redact';
import { runJobOnWorker } from '@adminforge/runner/src/worker-bridge';
import { TENANT, fakeWorkerCommand, isAlive, waitFor } from './helpers';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function payload(inputs: Record<string, unknown>, tokens: Record<string, string> = {}): WorkerJobPayload {
  return {
    jobId: 'pool-test',
    mode: 'read',
    script: { path: 'diagnostics/Test.ps1', sha256: '0'.repeat(64), content: 'unused by the fake worker' },
    inputs,
    tokens,
    tenant: TENANT,
    timeoutSeconds: 30,
  };
}

async function runOn(
  worker: PooledWorker,
  inputs: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal; exitGraceMs?: number; maxOutputBytes?: number } = {},
) {
  const events: RunnerEvent[] = [];
  const result = await runJobOnWorker({
    worker,
    payload: payload(inputs),
    timeoutMs: opts.timeoutMs ?? 10_000,
    signal: opts.signal ?? new AbortController().signal,
    redact: createRedactor(),
    emit: (e) => events.push(e),
    logger: silent,
    exitGraceMs: opts.exitGraceMs,
    maxOutputBytes: opts.maxOutputBytes,
  });
  return { ...result, events };
}

describe('worker pool lifecycle', () => {
  const pools: WorkerPool[] = [];
  const makePool = (opts: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) => {
    const pool = new WorkerPool({
      command: fakeWorkerCommand(),
      size: 2,
      maxJobs: 2,
      logger: silent,
      backoffBaseMs: 20,
      backoffMaxMs: 50,
      ...opts,
    });
    pools.push(pool);
    pool.start();
    return pool;
  };
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.close()));
  });

  it('pre-forks N workers that report ready', async () => {
    const pool = makePool();
    await waitFor(() => pool.status().ready === 2);
    expect(pool.status()).toMatchObject({ size: 2, ready: 2, busy: 0, consecutiveFailures: 0 });
    expect(pool.lastReady).toMatchObject({
      pwsh: 'fake-7.6',
      modules: [{ name: 'Fake.Module', version: '1.0.0' }],
    });
  });

  it('uses each worker for exactly one job and replaces it', async () => {
    const pool = makePool();
    await waitFor(() => pool.status().ready === 2);
    const worker = await pool.acquire({ timeoutMs: 5000 });
    expect(worker.state).toBe('busy');
    await waitFor(() => pool.status().ready === 2); // replacement is warm before the job even runs
    const { status, events } = await runOn(worker, { behaviour: 'echo' });
    expect(status).toBe('succeeded');
    expect(events.map((e) => e.type)).toEqual(['log', 'progress', 'output']);
    expect(worker.state).toBe('exited');
    expect(isAlive(worker.pid)).toBe(false);
    const next = await pool.acquire({ timeoutMs: 5000 });
    expect(next.pid).not.toBe(worker.pid);
    next.kill();
  });

  it('gives every worker a private HOME that is removed when it exits', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    expect(worker.home && existsSync(worker.home)).toBe(true);
    const { events } = await runOn(worker, { behaviour: 'echo' });
    const output = events.find((e) => e.type === 'output') as { data: { home: string } };
    expect(output.data.home).toBe(worker.home);
    await waitFor(() => !existsSync(worker.home!));
  });

  it('kills a worker that exceeds its timeout', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const started = Date.now();
    const { status, events } = await runOn(worker, { behaviour: 'hang' }, { timeoutMs: 300 });
    expect(status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events.at(-1)).toMatchObject({ type: 'error', category: 'timeout' });
    expect(isAlive(worker.pid)).toBe(false);
  });

  it('kills a worker when its job is cancelled', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled by test'), 200);
    const { status, events } = await runOn(worker, { behaviour: 'hang' }, { signal: controller.signal });
    expect(status).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      category: 'cancelled',
      message: 'The job was cancelled (cancelled by test)',
    });
    expect(isAlive(worker.pid)).toBe(false);
  });

  it('reports a worker that dies mid-job', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const { status, events } = await runOn(worker, { behaviour: 'crash' });
    expect(status).toBe('failed');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      category: 'runner',
      message: 'The runner worker exited unexpectedly (exit code 7)',
    });
  });

  it('trusts the exit report and kills a worker that lingers afterwards', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const { status } = await runOn(worker, { behaviour: 'exit-then-hang' }, { exitGraceMs: 100 });
    expect(status).toBe('succeeded');
    expect(isAlive(worker.pid)).toBe(false);
  });

  it('turns malformed and forged worker output into warnings', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const { status, events } = await runOn(worker, { behaviour: 'garbage' });
    expect(status).toBe('succeeded');
    expect(events.some((e) => e.type === 'done' || e.type === 'accepted')).toBe(false);
    expect(events[0]).toMatchObject({ type: 'log', level: 'info', message: 'this is not json' });
    expect(events.filter((e) => e.type === 'log' && e.level === 'warn')).toHaveLength(3);
    expect(events.find((e) => e.type === 'progress')).toMatchObject({ percent: 100 });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ category: 'script' });
  });

  it('stops a worker that floods output beyond the limit', async () => {
    const pool = makePool({ size: 1 });
    const worker = await pool.acquire({ timeoutMs: 5000 });
    const { status, events } = await runOn(worker, { behaviour: 'flood' }, { maxOutputBytes: 100_000 });
    expect(status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'error', category: 'protocol' });
    expect(events.filter((e) => e.type === 'output').length).toBeLessThan(200);
  });

  it('limits concurrent jobs and queues the rest', async () => {
    const pool = makePool({ size: 1, maxJobs: 1 });
    const first = await pool.acquire({ timeoutMs: 5000 });
    await waitFor(() => pool.status().ready === 1);
    let second: PooledWorker | undefined;
    const pending = pool.acquire({ timeoutMs: 5000 }).then((w) => (second = w));
    await new Promise((r) => setTimeout(r, 200));
    expect(second).toBeUndefined();
    expect(pool.status()).toMatchObject({ busy: 1, waiting: 1 });
    await runOn(first, { behaviour: 'echo' });
    await pending;
    expect(second?.state).toBe('busy');
    second?.kill();
  });

  it('times out an acquire when no worker frees up', async () => {
    const pool = makePool({ size: 1, maxJobs: 1 });
    const busy = await pool.acquire({ timeoutMs: 5000 });
    await expect(pool.acquire({ timeoutMs: 100 })).rejects.toBeInstanceOf(PoolTimeoutError);
    busy.kill();
  });

  it('backs off and reports unavailable when workers cannot start', async () => {
    const pool = makePool({ size: 1, command: fakeWorkerCommand({ FAKE_WORKER_STARTUP: 'crash' }) });
    await waitFor(() => pool.isUnavailable(), 10_000);
    expect(pool.status().consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(pool.status().lastError).toMatch(/fake worker cannot start/);
    await expect(pool.acquire({ timeoutMs: 1000 })).rejects.toBeInstanceOf(PoolUnavailableError);
  });

  it('counts a worker that never becomes ready as a startup failure', async () => {
    const pool = makePool({
      size: 1,
      readyTimeoutMs: 150,
      command: fakeWorkerCommand({ FAKE_WORKER_STARTUP: 'silent' }),
    });
    await waitFor(() => pool.status().consecutiveFailures >= 1, 5000);
    expect(pool.status().lastError).toMatch(/did not become ready/);
  });

  it('recovers once a worker starts again', async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'af-fail-once-')), 'marker');
    const pool = makePool({ size: 2, command: fakeWorkerCommand({ FAKE_WORKER_FAIL_ONCE_FILE: marker }) });
    await waitFor(() => pool.status().ready === 2);
    expect(pool.status()).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(existsSync(marker)).toBe(true);
    rmSync(path.dirname(marker), { recursive: true, force: true });
  });

  it('kills every worker and rejects waiters on close', async () => {
    const pool = makePool({ size: 2, maxJobs: 1 });
    await waitFor(() => pool.status().ready === 2);
    const busy = await pool.acquire({ timeoutMs: 5000 });
    const waiting = pool.acquire({ timeoutMs: 5000 }).catch((e: unknown) => e);
    await pool.close();
    expect(await waiting).toBeInstanceOf(PoolUnavailableError);
    expect(isAlive(busy.pid)).toBe(false);
    expect(pool.status()).toMatchObject({ closed: true, ready: 0, starting: 0, busy: 0 });
  });
});
