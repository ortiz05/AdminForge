import { verifyRunnerRequest } from '@adminforge/runner/src/auth';
import { decodeRunnerKey, prepareRunnerJob, signRunnerRequest } from '@adminforge/runner/src/client';
import { WorkerPool } from '@adminforge/runner/src/pool';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import { fakeWorkerCommand, job, makeScriptsDir, newKey, testConfig } from './helpers';

// The replay cache (job ids, 10 minutes) lives in memory. A request signed before the runner process started can
// only be a replay across a restart, inside the ±60 s window, so it is refused.

describe('requests signed before the runner started', () => {
  const key = newKey();
  const now = 1_800_000_000;

  it('are refused by the verifier', () => {
    const headers = signRunnerRequest({ key, method: 'GET', path: '/healthz', timestamp: now - 5 });
    const verify = (notBeforeSeconds?: number) =>
      verifyRunnerRequest({
        key: decodeRunnerKey(key),
        authorization: headers.authorization,
        timestamp: headers['x-adminforge-timestamp'],
        method: 'GET',
        path: '/healthz',
        body: Buffer.alloc(0),
        nowSeconds: now,
        notBeforeSeconds,
      });
    expect(verify()).toEqual({ ok: true });
    expect(verify(now - 5)).toEqual({ ok: true });
    expect(verify(now - 4)).toEqual({ ok: false, reason: 'before_start' });
  });

  it('are refused by the server, even with a valid signature inside the window', async () => {
    const scripts = makeScriptsDir();
    let clock = now;
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 1 });
    const app = await buildRunnerServer({
      config: testConfig(key, { scriptsDir: scripts.dir }),
      pool,
      logger: false,
      nowSeconds: () => clock,
    });
    try {
      clock = now + 20;
      // Captured before a restart (signed at now - 10), replayed 30 s later: still inside ±60 s.
      const captured = prepareRunnerJob({
        key,
        job: job({ script: { path: scripts.script, sha256: scripts.sha } }),
        timestamp: now - 10,
      });
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        payload: captured.body,
        headers: captured.headers,
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({
        message: expect.stringMatching(/older than this runner process/),
      });

      const fresh = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: signRunnerRequest({ key, method: 'GET', path: '/healthz', timestamp: clock }),
      });
      expect(fresh.statusCode).not.toBe(401);
    } finally {
      await app.close();
      scripts.cleanup();
    }
  });
});
