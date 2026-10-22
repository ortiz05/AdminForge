import { JobManager, JobRejectedError } from '@adminforge/runner/src/jobs';
import type { WorkerPool } from '@adminforge/runner/src/pool';
import type { RunnerJob } from '@adminforge/runner/src/protocol';
import { makeScriptsDir } from './helpers';

// The runner's queue is bounded (RUNNER_MAX_WAITING): once that many admitted jobs wait for a worker, the next is refused at
// once with 503 runner_busy — the API retries a 503 as a transient runner error — instead of queuing behind everyone
// else's until it times out (2026-10-22 security review).
const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;
const pool = (waiting: number) =>
  ({ isUnavailable: () => false, status: () => ({ waiting }) }) as unknown as WorkerPool;

describe('the runner job queue', () => {
  const scripts = makeScriptsDir();
  afterAll(() => scripts.cleanup());
  const job = (id: string): RunnerJob =>
    ({
      jobId: id,
      script: { path: scripts.script, sha256: scripts.sha },
      inputs: {},
      mode: 'read',
      tenant: { id: '00000000-0000-4000-8000-000000000001', domain: 'example.onmicrosoft.com' },
      timeoutSeconds: 60,
      tokens: {},
    }) as RunnerJob;

  const manager = () =>
    new JobManager({
      pool: pool(0),
      scriptsDir: scripts.dir,
      queueTimeoutMs: 1000,
      maxWaiting: 2,
      logger: silent,
    });

  it('refuses a job when the queue is full, counting jobs admitted but not yet given a worker', async () => {
    const jobs = manager();
    await jobs.admit(job('w1'));
    await jobs.admit(job('w2'));
    const err = await jobs.admit(job('j1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobRejectedError);
    expect(err).toMatchObject({ statusCode: 503, code: 'runner_busy' });
  });

  it('admits a job while there is room', async () => {
    const jobs = manager();
    await jobs.admit(job('w3'));
    await expect(jobs.admit(job('j2'))).resolves.toMatchObject({ job: { jobId: 'j2' } });
  });
});
