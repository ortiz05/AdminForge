import { harness, flush, schedule } from './helpers';

// F-09 / D-09 (decision: a missed tick is a `skipped` run with code `schedule_missed`, the status CHECK unchanged,
// audited, with an event). A tick overdue by more than the grace period (one hour) means the scheduler wasn't running
// — the pod was down, its volume re-attaching, or it crash-looped — and used to leave only a log line: the Schedules
// page went on showing last week's file as the latest. It now leaves a row people see, and a hint.
const MIN = 60_000;

async function started(h: ReturnType<typeof harness>) {
  await h.scheduler.start();
  await flush();
  return h;
}

const runsOf = async (h: ReturnType<typeof harness>, key: string) => {
  const s = (await h.store.getSchedule(key))!;
  return (await h.store.listRuns(s.id, { limit: 100 })).reverse();
};

describe('a missed tick', () => {
  it('is recorded as a skipped run that says when and why, audited, with an event', async () => {
    const h = await started(harness());
    h.defs.set(schedule('reports.weekly', { cron: '0 7 * * 1', timezone: 'Europe/London' }));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('reports.weekly'))!;
    // Due Monday 12 Oct 2026, 07:00 in London (06:00 UTC); the scheduler is back on Thursday 15 Oct at 12:00 UTC.
    const due = new Date('2026-10-12T06:00:00Z');
    await h.store.updateSchedule(row.id, { nextRunAt: due });
    h.published.length = 0;
    await h.scheduler.tick();

    expect(h.jobs.calls).toHaveLength(0);
    const [run, ...rest] = await runsOf(h, 'reports.weekly');
    expect(rest).toEqual([]);
    expect(run).toMatchObject({
      trigger: 'cron',
      status: 'skipped',
      startedAt: due,
      endedAt: new Date(h.clock.t),
      error: {
        code: 'schedule_missed',
        message:
          'AdminForge wasn’t running at 07:00 on 12 Oct 2026 (Europe/London), so this run was skipped.',
        hint: 'If you still need this run’s result, run the schedule now. It runs again at its next time as usual.',
      },
      result: {
        reason: 'AdminForge wasn’t running at 07:00 on 12 Oct 2026 (Europe/London), so this run was skipped.',
        missedAt: due.toISOString(),
      },
    });
    // The list shows it as the last run (not last week's success), and the next run is from now on.
    expect(await h.store.getSchedule('reports.weekly')).toMatchObject({
      lastStatus: 'skipped',
      lastRunAt: due,
      nextRunAt: new Date('2026-10-19T06:00:00Z'),
    });
    const audit = h.audit.rows.find((r) => r.action === 'schedule.run')!;
    expect(audit).toMatchObject({ result: 'success', targetId: 'reports.weekly', mode: 'read' });
    expect(audit.details).toMatchObject({
      status: 'skipped',
      trigger: 'cron',
      error: 'schedule_missed',
      scheduleRunId: run!.id,
    });
    expect(h.published).toContainEqual({
      type: 'schedule.updated',
      data: { key: 'reports.weekly', scheduleRunId: run!.id, status: 'skipped' },
    });
    await h.scheduler.stop();
  });

  it('is recorded once per schedule, however many of its times went by', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    // Every 15 minutes, down for five hours: one row, for the first time it missed.
    await h.store.updateSchedule(row.id, { nextRunAt: new Date(h.clock.t - 5 * 60 * MIN) });
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect((await runsOf(h, 'sweep.a')).map((r) => [r.status, r.error?.code])).toEqual([
      ['skipped', 'schedule_missed'],
    ]);
    await h.scheduler.stop();
  });

  it('within the grace period still runs once, late', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    await h.store.updateSchedule(row.id, { nextRunAt: new Date(h.clock.t - 59 * MIN) });
    await h.scheduler.tick();
    await h.scheduler.drain();
    expect(h.jobs.calls).toHaveLength(1);
    expect((await runsOf(h, 'sweep.a')).map((r) => r.status)).toEqual(['succeeded']);
    await h.scheduler.stop();
  });

  it('is missed, not paused, while automation is paused too', async () => {
    const h = await started(harness({ automationPaused: async () => true }));
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    await h.store.updateSchedule(row.id, { nextRunAt: new Date(h.clock.t - 2 * 60 * MIN) });
    await h.scheduler.tick();
    expect((await runsOf(h, 'sweep.a')).map((r) => r.error?.code)).toEqual(['schedule_missed']);
    await h.scheduler.stop();
  });

  it('a disabled schedule misses nothing', async () => {
    const h = await started(harness());
    h.defs.set(schedule('sweep.a'));
    await h.clock.advance(1);
    const row = (await h.store.getSchedule('sweep.a'))!;
    await h.store.updateSchedule(row.id, { enabled: false, nextRunAt: new Date(h.clock.t - 2 * 60 * MIN) });
    await h.scheduler.tick();
    expect(await runsOf(h, 'sweep.a')).toEqual([]);
    await h.scheduler.stop();
  });
});
