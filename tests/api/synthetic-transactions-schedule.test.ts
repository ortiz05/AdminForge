import { flush } from '../support/scheduler';
import { AVERY, FakeDefinitions, FakeJobs, probe, schedule, schedulesApp } from './schedules-helpers';

// Synthetic transactions (ADR-015) write to their test objects: a run in which they acted is audited as a write, with
// each transaction's outcome code, and a schedule that runs them doesn't run on demand while it is turned off.
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

function content(enabled: boolean) {
  return new FakeDefinitions()
    .set(
      probe('probes.mail-flow', {
        check: { kind: 'mailFlow', to: '${ env.AF_SYNTHETIC_MAILBOX }' },
        tags: ['synthetic-transaction'],
        timeoutMs: 110_000,
      }),
    )
    .set(probe('probes.graph', { tags: ['sweep-15m'] }))
    .set(
      schedule('sweep.synthetic-transactions', {
        enabled,
        job: { kind: 'probe', select: { tags: ['synthetic-transaction'] } },
      }),
    )
    .set(
      schedule('sweep.every-15-minutes', {
        enabled: false,
        job: { kind: 'probe', select: { tags: ['sweep-15m'] } },
      }),
    );
}

async function runNow(enabled: boolean, result: Record<string, unknown>) {
  const jobs = new FakeJobs(() => ({ result }));
  const t = await schedulesApp({ defs: content(enabled), jobs, inProcess: true });
  const op = await t.login(AVERY, OPERATOR);
  const res = await op.post('/api/schedules/sweep.synthetic-transactions/run');
  await flush();
  await t.clock.advance(1);
  await t.schedules.scheduler!.drain();
  return { t, res, op };
}

describe('synthetic transaction schedules', () => {
  it('audits a run in which transactions acted as a write, with their outcome codes', async () => {
    const { t, res } = await runNow(true, {
      probes: 1,
      ok: 0,
      warn: 1,
      crit: 0,
      error: 0,
      results: [{ key: 'probes.mail-flow', status: 'warn', metric: 12, code: 'cleanup_failed' }],
      transactions: 1,
      transactionCodes: { 'probes.mail-flow': 'cleanup_failed' },
    });
    expect(res.statusCode).toBe(202);
    const run = t.audit.rows.find((r) => r.action === 'schedule.run')!;
    expect(run.mode).toBe('write');
    expect(run.details).toMatchObject({ transactions: { 'probes.mail-flow': 'cleanup_failed' } });
    await t.close();
  });

  it('keeps a run in which nothing acted (not configured) a read', async () => {
    const { t } = await runNow(true, { probes: 1, ok: 0, warn: 0, crit: 0, error: 1, results: [] });
    const run = t.audit.rows.find((r) => r.action === 'schedule.run')!;
    expect(run.mode).toBe('read');
    expect(run.details).not.toHaveProperty('transactions');
    await t.close();
  });

  it('refuses Run now while the schedule is turned off; other probe sweeps still run on demand', async () => {
    const { t, res, op } = await runNow(false, { probes: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('schedule_disabled');
    expect(t.jobs.calls).toHaveLength(0);
    expect((await op.post('/api/schedules/sweep.every-15-minutes/run')).statusCode).toBe(202);
    await t.close();
  });
});
