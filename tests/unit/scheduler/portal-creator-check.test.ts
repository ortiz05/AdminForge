import type { CreatorAccessChecker, CreatorVerdict } from '@adminforge/api/src/schedules/creator-access';
import { Schedule } from '@adminforge/schemas';
import { flush, harness, schedule } from './helpers';

// The scheduler runs a report schedule created in the portal only while its creator could still create it. Confirmed
// loss: the run fails with creator_access_removed, the schedule is turned off (audited), no retry. Unverifiable: the
// run fails with creator_unverified and the schedule stays on (retries as usual). Content schedules aren't checked.

const AVERY = '00000000-0000-4000-8000-0000000000a1';
const KEY = 'portal.identity-x-abc123';

class FakeAccess implements CreatorAccessChecker {
  calls: Array<{ oid: string; roles: readonly string[] }> = [];
  constructor(public verdict: CreatorVerdict = { status: 'ok' }) {}
  async check(oid: string, roles: readonly string[]) {
    this.calls.push({ oid, roles });
    return this.verdict;
  }
}

const report = {
  kind: 'report',
  id: 'identity.x',
  version: '1.1.0',
  title: 'X',
  owner: 'identity-team',
  requires: { portalRoles: ['Portal.Admin'] },
};

async function setup(
  verdict?: CreatorVerdict,
  withChecker = true,
  extra: Parameters<typeof harness>[0] = {},
) {
  const access = new FakeAccess(verdict);
  const h = harness({ ...(withChecker ? { creatorAccess: access } : {}), ...extra });
  h.defs.set(report as never);
  const def = Schedule.parse({
    kind: 'schedule',
    id: KEY,
    version: '1.0.0',
    title: 'X weekly',
    owner: 'avery@example.com',
    cron: '0 * * * *',
    job: { kind: 'report', ref: 'identity.x', delivery: [{ type: 'file', format: 'csv' }] },
    retry: { max: 2, backoff: 'exponential', delay: '5m' },
    requires: { portalRoles: ['Portal.Operator', 'Portal.Reader'] },
  });
  const row = (await h.store.insertSchedule({
    key: KEY,
    source: 'portal',
    definition: def,
    sha256: 'sha-1',
    enabled: true,
    nextRunAt: new Date('2026-10-15T13:00:00Z'),
    createdBy: AVERY,
  }))!;
  await h.scheduler.start();
  await flush();
  const runs = async () => (await h.store.listRuns(row.id, { limit: 50 })).reverse();
  const fire = async () => {
    await h.clock.advance(3_600_000);
    await h.scheduler.drain();
  };
  return { h, access, row, runs, fire };
}

describe('creator check before portal schedule runs', () => {
  it('runs when the creator still has access; asks for Operator, the schedule’s and the report’s current roles', async () => {
    const { h, access, runs, fire } = await setup({ status: 'ok' });
    await fire();
    expect(access.calls).toEqual([
      { oid: AVERY, roles: ['Portal.Operator', 'Portal.Reader', 'Portal.Admin'] },
    ]);
    expect(h.jobs.calls).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({ trigger: 'cron', status: 'succeeded' });
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      summary: 'Scheduled by avery@example.com, executed as automation identity.',
    });
  });

  it('confirmed loss: no run, creator_access_removed, schedule turned off and audited, no retry', async () => {
    const { h, runs, fire } = await setup({
      status: 'removed',
      reason: 'missing_role',
      missing: ['Portal.Admin'],
    });
    await fire();
    expect(h.jobs.calls).toEqual([]);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'creator_access_removed',
        message: expect.stringContaining('they no longer hold the Portal.Admin role'),
        hint: expect.any(String),
      },
    });
    expect(await h.store.getSchedule(KEY)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.audit.rows.find((r) => r.action === 'schedule.disabled')).toMatchObject({
      actorUpn: 'automation identity',
      targetId: KEY,
      details: {
        reason: 'creator_access_removed',
        createdBy: 'avery@example.com',
        creatorOid: AVERY,
        detail: 'missing_role',
        missingRoles: ['Portal.Admin'],
      },
    });
    // Turned off: nothing fires later either.
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect(await runs()).toHaveLength(1);
  });

  it('cannot verify: no run, creator_unverified, the schedule stays on and retries', async () => {
    const { h, runs, fire } = await setup({ status: 'unverified', problem: 'Graph answered 503' });
    await fire();
    expect(h.jobs.calls).toEqual([]);
    const all = await runs();
    expect(all.map((r) => [r.trigger, r.status, r.error?.code ?? null])).toEqual([
      ['cron', 'failed', 'creator_unverified'],
      ['retry', 'queued', null],
    ]);
    expect(all[0]!.error!.hint).toMatch(/GroupMember\.Read\.All/);
    expect(await h.store.getSchedule(KEY)).toMatchObject({ enabled: true });
    expect(h.audit.rows.some((r) => r.action === 'schedule.disabled')).toBe(false);
  });

  it('checks run now and retries too', async () => {
    const { h, access, row } = await setup({ status: 'removed', reason: 'disabled' });
    await h.store.insertRun({
      scheduleId: row.id,
      scheduleKey: KEY,
      trigger: 'manual',
      status: 'queued',
      startedAt: h.clock.now(),
      result: { requestedBy: 'blake@example.com', requestedByOid: '00000000-0000-4000-8000-0000000000b2' },
    });
    h.scheduler.wake();
    await flush();
    await h.clock.advance(1);
    await h.scheduler.drain();
    expect(access.calls).toHaveLength(1);
    expect(h.jobs.calls).toEqual([]);
    expect((await h.store.listRuns(row.id, { limit: 5 }))[0]).toMatchObject({
      trigger: 'manual',
      status: 'failed',
      error: { code: 'creator_access_removed', message: expect.stringContaining('account is disabled') },
    });
  });

  it('content schedules are never checked; without a checker (mock mode) portal schedules just run', async () => {
    const checked = await setup({ status: 'removed', reason: 'guest' });
    checked.h.defs.set(schedule('sweep.a'));
    await checked.h.clock.advance(15 * 60_000);
    await checked.h.scheduler.drain();
    expect(checked.h.jobs.calls.map((c) => c.schedule.key)).toEqual(['sweep.a']);
    expect(checked.access.calls).toEqual([]);

    const mock = await setup(undefined, false);
    await mock.fire();
    expect(mock.h.jobs.calls.map((c) => c.schedule.key)).toEqual([KEY]);
  });

  it('a skipped run of a portal schedule is audited as scheduled by its creator', async () => {
    const { h, fire } = await setup({ status: 'ok' }, true, { automationPaused: async () => true });
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      status: 'skipped',
      summary: 'Scheduled by avery@example.com, executed as automation identity.',
    });
  });
});
