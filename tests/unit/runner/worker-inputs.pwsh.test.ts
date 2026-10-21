import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { submitRunnerJob } from '@adminforge/runner/src/client';
import { RUNNER_ROOT, buildWorkerCommand, findPwsh, loadRunnerConfig } from '@adminforge/runner/src/config';
import { WorkerPool } from '@adminforge/runner/src/pool';
import type { RunnerEvent } from '@adminforge/runner/src/protocol';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { job, logCapture, newKey, sha256 } from './helpers';

// The worker parses the job JSON; inputs must reach the script exactly as sent. PowerShell's ConvertFrom-Json turns
// ISO 8601 strings into DateTime unless told otherwise, which made Get-AdminForgeInput -Type String refuse them
// (e.g. the start and end of scheduled automatic replies).
const pwsh = findPwsh();
const hasPwsh =
  spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
const scriptsDir = path.resolve(RUNNER_ROOT, '../../content/scripts');
const TEST_RUNNER = 'diagnostics/Test-Runner.ps1';
const testRunnerSha = sha256(readFileSync(path.join(scriptsDir, TEST_RUNNER)));

describe.skipIf(!hasPwsh)('runner worker: job inputs', () => {
  const key = newKey();
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;
  let baseUrl = '';

  beforeAll(async () => {
    const env = {
      ...process.env,
      RUNNER_SHARED_KEY: key,
      RUNNER_POOL_SIZE: '1',
      RUNNER_MAX_JOBS: '2',
      RUNNER_PRELOAD_MODULES: 'none',
    };
    const config = { ...loadRunnerConfig(env), port: 0, scriptsDir };
    const pool = new WorkerPool({
      command: buildWorkerCommand(config, env),
      size: config.poolSize,
      maxJobs: config.maxJobs,
    });
    app = await buildRunnerServer({ config, pool, logger: { level: 'warn', stream: logCapture().stream } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }, 60_000);
  afterAll(() => app?.close());

  it.each(['2026-11-02T09:00:00+02:00', '2026-11-02T09:00:00Z', '2026-11-02'])(
    'keeps the ISO 8601 string %s a string',
    async (value) => {
      const events: RunnerEvent[] = [];
      for await (const e of submitRunnerJob({
        baseUrl,
        key,
        job: job({
          script: { path: TEST_RUNNER, sha256: testRunnerSha },
          inputs: { message: value, steps: 1 },
        }),
      }))
        events.push(e);
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect((events.find((e) => e.type === 'output') as { data: { message: string } }).data.message).toBe(
        value,
      );
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });
    },
    60_000,
  );
});
