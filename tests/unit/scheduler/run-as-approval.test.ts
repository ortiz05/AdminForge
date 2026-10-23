import { flush, harness, schedule } from './helpers';

// A write-capable schedule runs only as the account its two-person approval covered (approvedIdentity): if its account
// changed since (an Operator's override racing the approval), the run is refused, not made as an account nobody
// approved. Approvals from before accounts were recorded cover the account the definition names.
const MIN = 60_000;
const WRITE_JOB = {
  job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
};

async function approvedSchedule(patch: Record<string, unknown>) {
  const h = harness();
  await h.scheduler.start();
  await flush();
  h.defs.set(schedule('ops.write', WRITE_JOB));
  await h.clock.advance(1);
  const row = (await h.store.getSchedule('ops.write'))!;
  await h.store.updateSchedule(row.id, {
    enabled: true,
    approvedBy: 'blake@example.com',
    nextRunAt: new Date(h.clock.t + MIN),
    ...patch,
  });
  await h.clock.advance(2 * MIN);
  await h.scheduler.drain();
  const runs = (await h.store.listRuns(row.id, { limit: 10 })).reverse();
  await h.scheduler.stop();
  return { h, runs };
}

describe('a write-capable schedule and the account it was approved for', () => {
  it('runs as the approved account', async () => {
    const { runs } = await approvedSchedule({ approvedIdentity: 'automation' });
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
  });

  it('is refused when its account changed after the approval', async () => {
    const { h, runs } = await approvedSchedule({ approvedIdentity: 'automation', runAs: 'app:ops-team' });
    expect(runs.map((r) => [r.status, r.error?.code])).toEqual([['failed', 'approval_required']]);
    expect(runs[0]!.error?.message).toContain('account this schedule runs as changed after its approval');
    expect(h.jobs.calls).toHaveLength(0);
  });

  it('treats an approval from before accounts were recorded as covering the definition’s account', async () => {
    expect((await approvedSchedule({ approvedIdentity: null })).runs.map((r) => r.status)).toEqual([
      'succeeded',
    ]);
    const moved = await approvedSchedule({ approvedIdentity: null, runAs: 'app:ops-team' });
    expect(moved.runs.map((r) => r.error?.code)).toEqual(['approval_required']);
  });
});
