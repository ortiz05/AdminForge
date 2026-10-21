import type { RunJobHandler, RunQueue } from '@adminforge/api/src/runs/queue';
import { mockConfig } from './helpers';
import { buildTestApp } from './support/app';

// The API process is the run worker (ADR-016), so RUN_WORKER_CONCURRENCY — once read only by the separate worker
// entry — must reach the API's own worker. The default is 8 (F-08: steps mostly wait on Microsoft).
function recordingQueue() {
  const calls: Array<{ concurrency: number }> = [];
  const queue: RunQueue = {
    kind: 'memory',
    start: async () => undefined,
    enqueue: async () => undefined,
    work: async (_handler: RunJobHandler, opts: { concurrency: number }) => void calls.push(opts),
    stop: async () => undefined,
  };
  return { queue, calls };
}

describe('the API runs its worker with RUN_WORKER_CONCURRENCY', () => {
  it.each([
    [undefined, 8],
    ['9', 9],
  ])('RUN_WORKER_CONCURRENCY=%s → %i jobs at once', async (value, expected) => {
    const { queue, calls } = recordingQueue();
    const t = await buildTestApp(mockConfig(value ? { RUN_WORKER_CONCURRENCY: value } : {}), {
      deps: { runs: { queue, sweep: false } },
    });
    try {
      await t.app.ready();
      expect(calls).toEqual([{ concurrency: expected }]);
    } finally {
      await t.app.close();
    }
  });
});
