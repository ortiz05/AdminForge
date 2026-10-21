import { armMock, OPERATOR, rotationDefinitions, USER } from './arm-rotate-helpers';
import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, runsApp } from './runs-helpers';

// M6 (design review): one label for a run started before write access was turned on, wherever it is listed. The run
// list (and so the run dock) carries `waitingReason: 'prearm'` like the run view's `waiting.reason`, so "Waiting to be
// resumed" shows in the list, the dock and the run page alike.

describe('the run list says a run waits to be resumed', () => {
  it('waitingReason is prearm in GET /api/runs once the session armed; not before, and not after it resumed', async () => {
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
      const listed = (headers: Record<string, string>) =>
        t.app
          .inject({ method: 'GET', url: '/api/runs?scope=mine', headers })
          .then((r) =>
            (r.json() as { items: Array<Record<string, unknown>> }).items.find((i) => i.id === runId)!,
          );

      const before = await listed(avery.headers);
      expect(before.status).toBe('awaiting_arm');
      expect(before).not.toHaveProperty('waitingReason');

      t.clock.advance(3 * 60_000);
      const armed = await armMock(t.app, avery.headers);
      const after = await listed(armed.headers);
      expect(after).toMatchObject({ status: 'awaiting_arm', waitingReason: 'prearm' });
      // The run view carries it too, beside its `waiting.reason`.
      const view = (
        await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers })
      ).json().run;
      expect(view).toMatchObject({ waitingReason: 'prearm', waiting: { reason: 'prearm' } });

      expect(
        (await t.app.inject({ method: 'POST', url: `/api/runs/${runId}/resume`, headers: armed.headers }))
          .statusCode,
      ).toBe(202);
      await t.drain();
      const done = await listed(armed.headers);
      expect(done.status).toBe('succeeded');
      expect(done).not.toHaveProperty('waitingReason');
    } finally {
      await t.close();
    }
  });
});
