import { deliveryEnv, resolveRecipients, sendEmail } from '@adminforge/api/src/delivery/notifier';
import { planSync } from '@adminforge/api/src/schedules/sync';
import type { ScheduleRow } from '@adminforge/api/src/schedules/types';
import { Schedule } from '@adminforge/schemas';
import { flush } from '../unit/scheduler/helpers';
import { AVERY, FakeDefinitions, FakeJobs, schedule, schedulesApp } from './schedules-helpers';

const NOW = new Date('2026-10-15T12:00:00Z');

describe('schedule email recipients are configuration only (M5)', () => {
  const report = (to: string[]) => ({
    kind: 'schedule',
    id: 'reports.weekly',
    version: '1.0.0',
    title: 'Weekly',
    owner: 'tests',
    cron: '0 7 * * 1',
    job: { kind: 'report', ref: 'identity.expiry', delivery: [{ type: 'email', to }] },
  });

  it('content may only name ${ env.AF_…RECIPIENTS / EMAIL / ALERTS } keys', () => {
    expect(Schedule.safeParse(report(['${ env.AF_REPORT_RECIPIENTS }'])).success).toBe(true);
    expect(Schedule.safeParse(report(['${env.AF_SECURITY_ALERTS}', '${ env.AF_OPS_EMAIL }'])).success).toBe(
      true,
    );
    for (const bad of [
      'ops@example.com',
      '${ env.DATABASE_URL }',
      '${ env.AF_MAIL_SENDER }',
      '${ inputs.to }',
    ]) {
      const r = Schedule.safeParse(report([bad]));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/AF_…_RECIPIENTS/);
    }
  });

  it('delivery sees only the sender, recipient lists and webhooks — never the rest of the env file', () => {
    expect(
      deliveryEnv({
        AF_MAIL_SENDER: 'reports@example.com',
        AF_REPORT_RECIPIENTS: 'a@example.com',
        AF_APPROVALS_EMAIL: 'b@example.com',
        AF_SCHEDULE_ALERTS: 'c@example.com',
        AF_TEAMS_ALERTS_WEBHOOK: 'https://example.webhook.office.com/x',
        DATABASE_URL: 'postgres://user:pw@localhost/db',
        TOKEN_CACHE_KEY: 'k',
        AF_SPO_TENANT_NAME: 'example',
      }),
    ).toEqual({
      AF_MAIL_SENDER: 'reports@example.com',
      AF_REPORT_RECIPIENTS: 'a@example.com',
      AF_APPROVALS_EMAIL: 'b@example.com',
      AF_SCHEDULE_ALERTS: 'c@example.com',
      AF_TEAMS_ALERTS_WEBHOOK: 'https://example.webhook.office.com/x',
    });
  });

  it('literal addresses and other keys are never used as recipients, even if the env holds them', async () => {
    const env = { DATABASE_URL: 'leak@example.com', AF_REPORT_RECIPIENTS: 'ops@example.com' };
    expect(
      resolveRecipients(
        ['attacker@example.com', '${ env.DATABASE_URL }', '${ env.AF_REPORT_RECIPIENTS }'],
        env,
      ),
    ).toEqual({ to: ['ops@example.com'], missing: ['DATABASE_URL'] });
    const calls: unknown[] = [];
    const status = await sendEmail(
      {
        outbound: {
          execute: async (_i: unknown, call: unknown) => (calls.push(call), { data: null }),
        } as never,
        fetch: (() => Promise.reject(new Error('no network'))) as never,
        env: { AF_MAIL_SENDER: 'reports@example.com', DATABASE_URL: 'leak@example.com' },
        publicBaseUrl: 'https://portal.example.com',
      },
      { to: ['${ env.DATABASE_URL }', 'attacker@example.com'] },
      { title: 'Report', text: 'x' },
      'ref-1',
    );
    expect(status).toMatchObject({
      status: 'not_configured',
      message: expect.stringMatching(/AF_…_RECIPIENTS/),
    });
    expect(calls).toEqual([]);
  });
});

describe('schedule approvals (L7)', () => {
  const row = (over: Partial<ScheduleRow>): ScheduleRow =>
    ({
      id: '00000000-0000-4000-8000-00000000f001',
      key: 'ops.read',
      source: 'content',
      definition: schedule('ops.read'),
      sha256: 'old',
      enabled: true,
      createdBy: null,
      approvedBy: 'blake@example.com',
      approvedTarget: 'f'.repeat(64),
      nextRunAt: NOW,
      lastRunAt: null,
      lastStatus: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    }) as ScheduleRow;

  it('any change to an approved schedule voids the approval and switches it off, even if it now says read', () => {
    const plan = planSync([{ key: 'ops.read', def: schedule('ops.read'), sha256: 'new' }], [row({})], NOW);
    expect(plan.updates).toEqual([
      expect.objectContaining({
        key: 'ops.read',
        patch: expect.objectContaining({
          approvedBy: null,
          approvedTarget: null,
          enabled: false,
          nextRunAt: null,
        }),
      }),
    ]);
  });

  it('an unapproved read-only schedule keeps running when its content changes', () => {
    const plan = planSync(
      [{ key: 'ops.read', def: schedule('ops.read'), sha256: 'new' }],
      [row({ approvedBy: null, approvedTarget: null })],
      NOW,
    );
    expect(plan.updates[0]!.patch).toMatchObject({ enabled: true });
    expect(plan.updates[0]!.patch).not.toHaveProperty('approvedBy');
  });
});

describe('Run now (L5)', () => {
  it('hands the requester’s oid (not their UPN) to the job, so they can’t approve its gates', async () => {
    const jobs = new FakeJobs(() => ({ result: {} }));
    const defs = new FakeDefinitions().set(
      schedule('sweep.hourly', { job: { kind: 'probe', ref: 'probes.example' } }),
    );
    const t = await schedulesApp({ defs, jobs, inProcess: true });
    const op = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    expect((await op.post('/api/schedules/sweep.hourly/run')).statusCode).toBe(202);
    await flush();
    await t.clock.advance(1);
    await t.schedules.scheduler!.drain();
    expect(jobs.calls[0]).toMatchObject({ scheduledBy: AVERY.upn, requestedByOid: AVERY.oid });
    await t.close();
  });
});
