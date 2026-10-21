import { armMock, OPERATOR, rotationDefinitions, USER } from './arm-rotate-helpers';
import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, runsApp } from './runs-helpers';

// S-08: a run bound to a session before it gained write access waits for its person to resume it before it writes.
// The run view says so (`waiting.reason: 'prearm'`, with when the run started), so the run page can ask them to check
// it's one they started instead of showing the plain "write access is on, resume" banner.

describe('a run started before write access was turned on says why it waits', () => {
  it('waiting.reason is prearm once the session armed, with the run’s start time; not before', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: rotationDefinitions(),
      outbound: new FakeExecutor(() => ({})),
    });
    try {
      const avery = await t.login(AVERY, OPERATOR); // read-only
      const { runId } = (
        await avery.post('/api/runs', { playbook: 'test.read-then-write', inputs: { userId: USER } })
      ).json() as { runId: string };
      await t.drain();
      const before = (await avery.get(`/api/runs/${runId}`)).json().run;
      expect(before.status).toBe('awaiting_arm');
      expect(before.waiting).toMatchObject({ kind: 'arm', stepId: 'disable' });
      expect(before.waiting.reason).toBeUndefined();

      t.clock.advance(3 * 60_000);
      const armed = await armMock(t.app, avery.headers);
      const after = (
        await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers })
      ).json().run;
      expect(after.status).toBe('awaiting_arm');
      expect(after.waiting).toMatchObject({
        kind: 'arm',
        stepId: 'disable',
        reason: 'prearm',
        startedAt: before.startedAt,
      });
      expect(after.waiting.startedAt).toEqual(expect.any(String));

      // Resumed by its person, it writes; the reason is gone with the wait.
      expect(
        (await t.app.inject({ method: 'POST', url: `/api/runs/${runId}/resume`, headers: armed.headers }))
          .statusCode,
      ).toBe(202);
      await t.drain();
      const done = (
        await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers })
      ).json().run;
      expect(done).toMatchObject({ status: 'succeeded', waiting: null });
    } finally {
      await t.close();
    }
  });
});
