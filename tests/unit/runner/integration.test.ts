import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  RunnerRequestError,
  cancelRunnerJob,
  signRunnerRequest,
  submitRunnerJob,
} from '@adminforge/runner/src/client';
import {
  type PreloadService,
  RUNNER_ROOT,
  buildWorkerCommand,
  findPwsh,
  loadRunnerConfig,
} from '@adminforge/runner/src/config';
import { readModulesLock } from '@adminforge/runner/src/health';
import { WorkerPool } from '@adminforge/runner/src/pool';
import type { RunnerEvent, RunnerJobRequest } from '@adminforge/runner/src/protocol';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { fakeJwt, job, logCapture, newKey, sha256, waitFor } from './helpers';

// End-to-end: the real supervisor, real pwsh workers (ps/worker.ps1) and the real diagnostics script.
const pwsh = findPwsh();
const hasPwsh =
  spawnSync(
    pwsh,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8' },
  ).status === 0;
const lock = readModulesLock();
const modulesDir = path.join(RUNNER_ROOT, 'modules');
const modulesInstalled = Object.entries(lock.modules).every(([name, version]) =>
  existsSync(path.join(modulesDir, name, version, `${name}.psd1`)),
);
const scriptsDir = path.resolve(RUNNER_ROOT, '../../content/scripts');
const TEST_RUNNER = 'diagnostics/Test-Runner.ps1';
const testRunnerSha = sha256(readFileSync(path.join(scriptsDir, TEST_RUNNER)));

interface HealthBody {
  status: string;
  pool: { ready: number; size: number; maxJobs: number };
  pwsh: { version: string | null };
  modules: {
    items: Array<{ name: string; pinned: string; loaded: string | null }>;
    preloadFailures: unknown[];
  };
}

interface TestRunnerOutput {
  echo: Record<string, unknown>;
  message: string;
  pwsh: string;
  environment: string[];
  services: string[];
}

async function startRunner(key: string, preload: PreloadService[], poolSize = 1) {
  const logs = logCapture();
  const env = {
    ...process.env,
    RUNNER_SHARED_KEY: key,
    RUNNER_POOL_SIZE: String(poolSize),
    RUNNER_MAX_JOBS: '3',
    RUNNER_PRELOAD_MODULES: preload.join(',') || 'none',
  };
  const config = { ...loadRunnerConfig(env), port: 0, scriptsDir };
  const pool = new WorkerPool({
    command: buildWorkerCommand(config, env),
    size: config.poolSize,
    maxJobs: config.maxJobs,
  });
  const app = await buildRunnerServer({ config, pool, logger: { level: 'debug', stream: logs.stream } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const health = async () => {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: signRunnerRequest({ key, method: 'GET', path: '/healthz' }),
    });
    return { status: res.status, body: (await res.json()) as HealthBody };
  };
  return { app, baseUrl, logs, health };
}

async function collect(
  baseUrl: string,
  key: string,
  body: RunnerJobRequest,
  onEvent?: (e: RunnerEvent) => Promise<void> | void,
) {
  const events: RunnerEvent[] = [];
  for await (const event of submitRunnerJob({ baseUrl, key, job: body })) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}

const testRunner = (inputs: Record<string, unknown>, extra: Partial<RunnerJobRequest> = {}) =>
  job({ script: { path: TEST_RUNNER, sha256: testRunnerSha }, inputs, ...extra });

describe.skipIf(!hasPwsh)('runner with real pwsh workers', () => {
  const key = newKey();
  let runner: Awaited<ReturnType<typeof startRunner>>;

  beforeAll(async () => {
    runner = await startRunner(key, []);
  }, 60_000);
  afterAll(() => runner?.app.close());

  it('runs diagnostics/Test-Runner.ps1 and streams its events in order', async () => {
    const events = await collect(
      runner.baseUrl,
      key,
      testRunner({ message: 'hello from vitest', steps: 3, reportEnvironment: true }),
    );
    expect(events[0]).toMatchObject({ type: 'accepted' });
    expect(
      events.filter((e) => e.type === 'progress').map((e) => (e as { percent: number }).percent),
    ).toEqual([33, 66, 100]);
    const output = events.find((e) => e.type === 'output') as { data: TestRunnerOutput };
    expect(output.data).toMatchObject({
      message: 'hello from vitest',
      steps: 3,
      mode: 'read',
      services: [],
      tenant: { Domain: 'example.onmicrosoft.com' },
    });
    expect(output.data.echo).toEqual({ message: 'hello from vitest', steps: 3, reportEnvironment: true });
    expect(output.data.pwsh).toMatch(/^7\./);
    // The worker inherits only the allowlisted environment.
    expect(output.data.environment).not.toContain('RUNNER_SHARED_KEY');
    expect(output.data.environment).toContain('ADMINFORGE_RUNNER_MODULES_DIR');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });
  }, 60_000);

  it('passes inputs as data, never as code', async () => {
    const hostile = '$(Remove-Item -Recurse /tmp/x); `"; exit 1 #';
    const events = await collect(runner.baseUrl, key, testRunner({ message: hostile, steps: 1 }));
    expect((events.find((e) => e.type === 'output') as { data: { message: string } }).data.message).toBe(
      hostile,
    );
    expect(events.at(-1)).toMatchObject({ status: 'succeeded' });
  }, 60_000);

  it('fails a read-mode script that calls Set-Mailbox with "not allowed in read-only mode"', async () => {
    const events = await collect(runner.baseUrl, key, testRunner({ steps: 1, attemptWrite: true }));
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ category: 'readOnly' });
    expect((error as { message: string }).message).toMatch(
      /^'Set-Mailbox' is not allowed in read-only mode\..*\(line \d+\)$/,
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  }, 60_000);

  it('does not apply the read-only guard in write mode', async () => {
    const events = await collect(
      runner.baseUrl,
      key,
      testRunner({ steps: 1, attemptWrite: true }, { mode: 'write' }),
    );
    const error = events.find((e) => e.type === 'error') as { category: string; message: string };
    expect(error.category).toBe('script');
    expect(error.message).toMatch(/not recognized/); // Exchange is simply not connected
  }, 60_000);

  it('reports script failures and input validation errors with categories', async () => {
    const failed = await collect(runner.baseUrl, key, testRunner({ fail: true }));
    expect(failed.find((e) => e.type === 'error')).toMatchObject({
      category: 'script',
      message: expect.stringMatching(/Test-Runner was asked to fail/),
    });
    const invalid = await collect(runner.baseUrl, key, testRunner({ steps: 500 }));
    expect(invalid.find((e) => e.type === 'error')).toMatchObject({
      category: 'input',
      message: expect.stringMatching(/Input 'steps' must be between 1 and 20/),
    });
  }, 60_000);

  it('kills a job at its timeout', async () => {
    const started = Date.now();
    const events = await collect(
      runner.baseUrl,
      key,
      testRunner({ steps: 1, sleepSeconds: 60 }, { timeoutSeconds: 2 }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('cancels a running job', async () => {
    const body = testRunner({ steps: 1, sleepSeconds: 60 });
    const events = await collect(runner.baseUrl, key, body, async (e) => {
      if (e.type === 'log' && e.message.startsWith('Sleeping'))
        await cancelRunnerJob({ baseUrl: runner.baseUrl, key, jobId: body.jobId });
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
  }, 60_000);

  it('refuses a script whose sha256 does not match', async () => {
    const error = await collect(
      runner.baseUrl,
      key,
      job({ script: { path: TEST_RUNNER, sha256: sha256('tampered') } }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RunnerRequestError);
    expect(error).toMatchObject({ status: 409, code: 'script_hash_mismatch' });
  });

  it('reports pwsh and pool status on /healthz', async () => {
    await waitFor(async () => (await runner.health()).body.pool.ready >= 1, 30_000);
    const { status, body } = await runner.health();
    expect(status).toBe(200);
    expect(body.pwsh.version).toMatch(/^7\./);
    expect(body.pool).toMatchObject({ size: 1, maxJobs: 3 });
  }, 60_000);

  it.skipIf(!modulesInstalled)(
    'connects Graph with a forwarded token without the token reaching any log or event',
    async () => {
      const token = fakeJwt();
      const events = await collect(
        runner.baseUrl,
        key,
        testRunner({ steps: 1 }, { tokens: { graph: token } }),
      );
      expect(events.at(-1)).toMatchObject({ status: 'succeeded' });
      expect(
        (events.find((e) => e.type === 'output') as { data: { services: string[] } }).data.services,
      ).toEqual(['Graph']);
      expect(JSON.stringify(events)).not.toContain(token);
      expect(runner.logs.text()).not.toContain(token);
      expect(runner.logs.text()).toContain('job finished');
    },
    60_000,
  );
});

describe.skipIf(!hasPwsh || !modulesInstalled)('runner workers with all pinned modules preloaded', () => {
  const key = newKey();
  let runner: Awaited<ReturnType<typeof startRunner>>;

  beforeAll(async () => {
    runner = await startRunner(key, ['Graph', 'Exchange', 'Teams', 'SharePoint', 'Az']);
  }, 60_000);
  afterAll(() => runner?.app.close());

  it('imports every pinned module at the pinned version and reports ok', async () => {
    await waitFor(async () => (await runner.health()).body.pool.ready >= 1, 60_000, 250);
    const { body } = await runner.health();
    expect(body.status).toBe('ok');
    expect(body.modules.preloadFailures).toEqual([]);
    for (const item of body.modules.items) expect(item.loaded, item.name).toBe(item.pinned);
  }, 90_000);

  it('runs a job on a fully loaded worker', async () => {
    const events = await collect(runner.baseUrl, key, testRunner({ steps: 1, attemptWrite: true }));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ category: 'readOnly' });
  }, 90_000);
});
