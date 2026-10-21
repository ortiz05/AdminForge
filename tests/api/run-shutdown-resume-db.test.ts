import { StaticDefinitions } from './runs-helpers';
import { playbook, restartKit, until, write } from './runs-restart-helpers';

// D-01: stopping the API (what SIGTERM does: app.close() runs the runs module's graceful stop) interrupts runs instead
// of cancelling them. Runs stop at their next checkpoint; a step still in flight after the queue's grace is
// interrupted and stays `running`; the jobs go back in the queue. After the restart the next process resumes them:
// an interrupted idempotent step is retried, an `idempotent: false` one ends `needs_review`.
const GRACE_MS = 300;

const definitions = () =>
  new StaticDefinitions()
    .add(playbook('test.restart', [write('one'), write('two'), write('three')]))
    .add(playbook('test.restart-tap', [write('one'), write('two', { idempotent: false }), write('three')]))
    .add(playbook('test.restart-child', [write('two')]))
    .add(
      playbook('test.restart-parent', [
        write('one'),
        { id: 'child', type: 'playbook', ref: 'test.restart-child', describe: 'Run the child' },
        write('three'),
      ]),
    );

describe('a stopped API resumes its runs after the restart (D-01)', () => {
  let k: Awaited<ReturnType<typeof restartKit>>;
  beforeEach(async () => {
    k = await restartKit(definitions);
  });
  afterEach(async () => {
    await k.close();
  });

  it('a step still in flight after the grace is interrupted, and retried after the restart', async () => {
    const first = await k.boot({ graceMs: GRACE_MS });
    const { runId } = await k.startHeld(first, 'test.restart', 'two');
    const stopping = Date.now();
    await first.app.close(); // SIGTERM
    expect(Date.now() - stopping).toBeGreaterThanOrEqual(GRACE_MS - 20); // the step had its grace
    expect(k.run(runId).status).toBe('running');
    expect(k.latest(runId)).toEqual({ one: 'succeeded', two: 'running' });
    expect(k.jobs(runId)).toEqual([{ state: 'queued' }]);
    expect(k.logs(runId).some((m) => /restarting/.test(m))).toBe(true);

    k.outbound.hold = null;
    const second = await k.boot();
    try {
      await until(() => k.run(runId).status === 'succeeded');
      expect(k.outbound.calls).toEqual([
        'PATCH /things/one',
        'PATCH /things/two',
        'PATCH /things/two',
        'PATCH /things/three',
      ]);
      const steps = k.steps(runId);
      expect(steps.map((s) => [s.stepId, s.status, s.attempt])).toEqual([
        ['one', 'succeeded', 1],
        ['two', 'retried', 1],
        ['two', 'succeeded', 2],
        ['three', 'succeeded', 1],
      ]);
      expect(JSON.parse(steps[1]!.error!)).toMatchObject({ code: 'interrupted' });
      expect(k.runStatuses(runId)).not.toContain('cancelled');
      await until(() => k.jobs(runId).length === 0);
    } finally {
      await second.app.close();
    }
  });

  it('an interrupted idempotent: false step is not sent again: the resumed run ends needs_review', async () => {
    const first = await k.boot({ graceMs: GRACE_MS });
    const { runId } = await k.startHeld(first, 'test.restart-tap', 'two');
    await first.app.close();
    expect(k.run(runId).status).toBe('running');
    expect(k.latest(runId)).toEqual({ one: 'succeeded', two: 'running' });

    k.outbound.hold = null;
    const second = await k.boot();
    try {
      await until(() => k.run(runId).status === 'needs_review');
      expect(JSON.parse(k.run(runId).error!)).toMatchObject({ code: 'needs_review', stepId: 'two' });
      expect(k.latest(runId)).toEqual({ one: 'succeeded', two: 'needs_review' });
      expect(k.outbound.calls).toEqual(['PATCH /things/one', 'PATCH /things/two']); // never sent twice
      expect(k.runStatuses(runId)).not.toContain('cancelled');
    } finally {
      await second.app.close();
    }
  });

  it('a step that finishes within the grace is kept: the run stops before the next one and repeats nothing', async () => {
    const first = await k.boot({ graceMs: GRACE_MS });
    const { runId } = await k.startHeld(first, 'test.restart-tap', 'two');
    const closed = first.app.close();
    await new Promise((r) => setTimeout(r, 50));
    k.outbound.release(); // `two` answers while the API is stopping
    await closed;
    expect(k.run(runId).status).toBe('running');
    expect(k.latest(runId)).toEqual({ one: 'succeeded', two: 'succeeded' });
    expect(k.jobs(runId)).toEqual([{ state: 'queued' }]);

    k.outbound.hold = null;
    const second = await k.boot();
    try {
      await until(() => k.run(runId).status === 'succeeded');
      expect(k.outbound.calls).toEqual(['PATCH /things/one', 'PATCH /things/two', 'PATCH /things/three']);
    } finally {
      await second.app.close();
    }
  });

  it('a child run interrupted with its parent resumes as the same child', async () => {
    const first = await k.boot({ graceMs: GRACE_MS });
    const { runId } = await k.startHeld(first, 'test.restart-parent', 'two');
    await first.app.close();
    expect(k.run(runId).status).toBe('running');
    expect(k.latest(runId)).toEqual({ one: 'succeeded', child: 'running' });
    const [child, ...more] = k.children(runId);
    expect(more).toEqual([]);
    expect(child!.status).toBe('running');
    expect(k.latest(child!.id)).toEqual({ two: 'running' });

    k.outbound.hold = null;
    const second = await k.boot();
    try {
      await until(() => k.run(runId).status === 'succeeded');
      expect(k.children(runId)).toEqual([{ id: child!.id, status: 'succeeded' }]);
      expect(k.outbound.calls).toEqual([
        'PATCH /things/one',
        'PATCH /things/two',
        'PATCH /things/two',
        'PATCH /things/three',
      ]);
    } finally {
      await second.app.close();
    }
  });

  it("a person's cancel is still a cancel (a plain abort, not an interrupt)", async () => {
    const first = await k.boot({ graceMs: GRACE_MS });
    const { runId, avery } = await k.startHeld(first, 'test.restart', 'two');
    expect((await avery.post(`/api/runs/${runId}/cancel`, {})).statusCode).toBe(200);
    await until(() => k.latest(runId).two === 'cancelled');
    await first.app.close();
    expect(k.run(runId).status).toBe('cancelled');
    expect(k.jobs(runId)).toEqual([]);
  });
});
