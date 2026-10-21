import { createDatabase } from '@adminforge/api/src/db/client';
import { SqliteRunRepository } from '@adminforge/api/src/runs';
import { StaticDefinitions } from './runs-helpers';
import { playbook, restartKit, until, write } from './runs-restart-helpers';

// D-01: a worker whose run lock lapsed (it stalled past the lease) interrupts the run instead of cancelling it. It
// writes nothing more — not even a late answer — so it never overwrites a run another worker now drives; it tries
// again shortly, and resumes the run itself only if no one else holds it.
const TTL_MS = 400;

const definitions = () =>
  new StaticDefinitions().add(playbook('test.lock', [write('one'), write('two'), write('three')]));

describe('a lost run lock interrupts, never cancels (D-01)', () => {
  let k: Awaited<ReturnType<typeof restartKit>>;
  beforeEach(async () => {
    k = await restartKit(definitions);
  });
  afterEach(async () => {
    await k.close();
  });

  it('a run another worker took over is left to it: no cancel, and a late answer is not recorded', async () => {
    let skew = 0; // this worker's clock: it jumps when the process "stalls"
    const stalled = await k.boot({
      now: () => new Date(Date.now() + skew),
      lockTtlMs: TTL_MS,
      lockRenewMs: 50,
    });
    k.outbound.ignoreAbort = true; // the stalled call answers late, whatever the abort says
    const { runId } = await k.startHeld(stalled, 'test.lock', 'two');

    // The process stalls past the lease and another worker (another connection) takes the run over.
    const otherDb = createDatabase(k.file, { name: 'other-worker' });
    const other = new SqliteRunRepository(otherDb, () => new Date(Date.now() + 10 * TTL_MS));
    skew = 10 * TTL_MS;
    const taken = await other.tryLock(runId);
    try {
      expect(taken).not.toBeNull();
      // The other worker finishes the run.
      await other.updateRun(runId, { status: 'succeeded', endedAt: new Date() }, ['running']);
      // The stalled worker notices at its next renewal; its call then answers anyway.
      await new Promise((r) => setTimeout(r, 150));
      k.outbound.release();
      await until(() => k.jobs(runId).length === 0 && stalled.app.runs.worker.activeRuns().length === 0);

      expect(k.run(runId).status).toBe('succeeded');
      expect(k.runStatuses(runId)).not.toContain('cancelled');
      // The late answer to `two` was dropped; nothing after it ran here.
      expect(k.latest(runId)).toEqual({ one: 'succeeded', two: 'running' });
      expect(k.outbound.calls).toEqual(['PATCH /things/one', 'PATCH /things/two']);
      expect(k.logs(runId).filter((m) => /restarting/.test(m))).toEqual([]);
    } finally {
      await taken?.release();
      await otherDb.close();
      await stalled.app.close();
    }
  });

  it('when no one took the run over, the worker resumes it itself', async () => {
    let skew = 0;
    const worker = await k.boot({
      now: () => new Date(Date.now() + skew),
      lockTtlMs: TTL_MS,
      lockRenewMs: 50,
    });
    const { runId } = await k.startHeld(worker, 'test.lock', 'two');
    k.outbound.hold = null;
    skew = 10 * TTL_MS; // stalled past the lease: the next renewal fails, the call in flight is aborted
    try {
      await until(() => k.run(runId).status === 'succeeded');
      expect(k.outbound.calls).toEqual([
        'PATCH /things/one',
        'PATCH /things/two',
        'PATCH /things/two',
        'PATCH /things/three',
      ]);
      expect(k.steps(runId).map((s) => [s.stepId, s.status])).toEqual([
        ['one', 'succeeded'],
        ['two', 'retried'],
        ['two', 'succeeded'],
        ['three', 'succeeded'],
      ]);
      expect(k.runStatuses(runId)).not.toContain('cancelled');
    } finally {
      await worker.app.close();
    }
  });
});
