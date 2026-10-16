import { FakeJobs, flush, harness, schedule } from './helpers';

const MIN = 60_000;

/** Emergency stop (ENG-08): while automation is paused nothing fires; each occurrence is a skipped run with why. */
describe('scheduler: automation paused', () => {
  const pausable = (jobs = new FakeJobs()) => {
    const state = { paused: false };
    const h = harness({ jobs, automationPaused: async () => state.paused });
    return { h, state };
  };
  const runsOf = async (h: ReturnType<typeof harness>, key: string) => {
    const s = (await h.store.getSchedule(key))!;
    return (await h.store.listRuns(s.id, { limit: 100 })).reverse();
  };

  it('records due ticks as skipped (with the reason the Schedules page shows) and fires again once resumed', async () => {
    const { h, state } = pausable();
    await h.scheduler.start();
    await flush();
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    state.paused = true;

    await h.clock.advance(15 * MIN);
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(0);
    const [skipped] = await runsOf(h, 'sweep.a');
    expect(skipped).toMatchObject({
      trigger: 'cron',
      status: 'skipped',
      error: { code: 'automation_paused', message: expect.stringContaining('paused automation') },
      result: { reason: expect.stringContaining('paused automation') },
    });
    expect(skipped!.error!.hint).toMatch(/Portal Admin/);
    // The schedule moves on to its next tick instead of piling up.
    expect((await h.store.getSchedule('sweep.a'))!.nextRunAt?.toISOString()).toBe('2026-10-15T12:30:00.000Z');
    const audit = h.audit.rows.find((r) => r.action === 'schedule.run')!;
    expect(audit).toMatchObject({ result: 'success', targetId: 'sweep.a' });
    expect(audit.details).toMatchObject({ status: 'skipped', error: 'automation_paused' });
    expect(h.published.some((e) => e.type === 'schedule.updated' && e.data.status === 'skipped')).toBe(true);

    state.paused = false;
    await h.clock.advance(15 * MIN);
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(1);
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['skipped', 'succeeded']);
    await h.scheduler.stop();
  });

  it('skips queued runs (Run now, retries) while paused, keeping who asked', async () => {
    const { h, state } = pausable();
    await h.scheduler.start();
    await flush();
    h.defs.set(schedule('sweep.b'));
    await h.clock.advance(1);
    state.paused = true;
    const row = (await h.store.getSchedule('sweep.b'))!;
    const queued = await h.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'manual',
      status: 'queued',
      startedAt: h.clock.now(),
      result: { requestedBy: 'avery@example.com' },
    });
    h.scheduler.wake();
    await h.clock.advance(1);
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(0);
    expect(await h.store.getRun(queued.id)).toMatchObject({
      status: 'skipped',
      result: { requestedBy: 'avery@example.com' },
      error: { code: 'automation_paused' },
    });
    await h.scheduler.stop();
  });

  it('does not stop a run that was already going when automation was paused', async () => {
    const jobs = new FakeJobs();
    jobs.manual = true;
    const { h, state } = pausable(jobs);
    await h.scheduler.start();
    await flush();
    h.defs.set(schedule('sweep.c', { timeoutSeconds: 3600 }));
    await h.clock.advance(15 * MIN);
    expect(jobs.pending).toBe(1);
    state.paused = true;
    await h.clock.advance(1);
    jobs.finish();
    await h.scheduler.drain();
    expect((await runsOf(h, 'sweep.c')).map((r) => r.status)).toEqual(['succeeded']);
    await h.scheduler.stop();
  });

  it('one-shot runs (runOnce) are skipped too', async () => {
    const { h, state } = pausable();
    h.defs.set(schedule('sweep.d'));
    state.paused = true;
    const run = await h.scheduler.runOnce('sweep.d', 'host operator');
    expect(run).toMatchObject({
      status: 'skipped',
      trigger: 'manual',
      result: { requestedBy: 'host operator' },
      error: { code: 'automation_paused' },
    });
    expect(h.jobs.calls).toHaveLength(0);
  });
});
