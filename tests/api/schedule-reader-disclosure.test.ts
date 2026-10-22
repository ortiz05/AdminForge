import { AppError } from '@adminforge/api/src/errors';
import type { ScheduleEvent } from '@adminforge/api/src/schedules/events';
import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  FakeDefinitions,
  FakeJobs,
  READER,
  schedule,
  schedulesApp,
} from './schedules-helpers';

// A scheduled run collects data with application permissions, so its error message (which can name what it looked
// at) and its run id are for the roles that may see the schedule's data — the schedule's requires.portalRoles
// (default Portal.Operator) and its report's or playbook's own. Everyone else sees the status and the error code.
// The same holds for the schedule.failed browser event (every signed-in session gets it) and for the schedule
// editor's scaffold, which copies a definition's requirements.
const SECRET = 'Mailbox finance-ceo@example.com: access denied';
const RUN_ID = '00000000-0000-4000-8000-0000000000aa';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

const adminReport = {
  kind: 'report' as const,
  id: 'identity.admin-only',
  version: '1.0.0',
  title: 'Admin-only report',
  owner: 'identity-team',
  requires: { portalRoles: ['Portal.Admin'], scopes: { graph: ['AuditLog.Read.All'] } },
};
const operatorPlaybook = {
  kind: 'playbook' as const,
  id: 'identity.operator-check',
  version: '1.0.0',
  title: 'Operator check',
  mode: 'read',
  requires: { portalRoles: ['Portal.Operator'], scopes: { graph: ['User.Read.All'] } },
  steps: [],
};

async function setup(respond: ConstructorParameters<typeof FakeJobs>[0]) {
  const defs = new FakeDefinitions()
    .set(adminReport)
    .set(operatorPlaybook)
    .set(schedule('reports.probe-sweep'))
    .set(schedule('reports.admin-schedule', { requires: { portalRoles: ['Portal.Admin'] } }))
    .set(
      schedule('reports.admin-report', {
        job: { kind: 'report', ref: 'identity.admin-only', delivery: [{ type: 'file', format: 'xlsx' }] },
      }),
    );
  const t = await schedulesApp({ defs, jobs: new FakeJobs(respond), inProcess: true });
  const events: ScheduleEvent[] = [];
  t.schedules.events.on((e) => events.push(e));
  const admin = await t.login(BLAKE, ALL_ROLES);
  const run = async (key: string) => {
    expect((await admin.post(`/api/schedules/${key}/run`)).statusCode).toBe(202);
    await t.clock.advance(1);
    await t.schedules.scheduler!.drain();
  };
  return { t, events, admin, run };
}

const failed = () => ({
  status: 'failed' as const,
  runId: RUN_ID,
  error: { code: 'run_failed', message: SECRET },
});
const history = async (who: { get(url: string): Promise<{ json(): unknown }> }, key: string) =>
  ((await who.get(`/api/schedules/${key}/runs`)).json() as { items: Array<Record<string, unknown>> })
    .items[0]!;

describe('scheduled run details are role-gated', () => {
  it('gives a Reader the status and the code, not the message or the run id', async () => {
    const { t, run } = await setup(failed);
    await run('reports.probe-sweep');
    const reader = await t.login(READER, ['Portal.Reader']);
    const seen = await history(reader, 'reports.probe-sweep');
    expect(seen).toMatchObject({ status: 'failed', error: { code: 'run_failed' } });
    expect(JSON.stringify(seen)).not.toContain('finance-ceo');
    expect(seen.runId).toBeUndefined();
    expect(seen.error).toEqual({
      code: 'run_failed',
      message: 'The details are shown only to people with the Portal.Operator role.',
    });

    const op = await t.login(AVERY, OPERATOR);
    expect(await history(op, 'reports.probe-sweep')).toMatchObject({
      runId: RUN_ID,
      error: { code: 'run_failed', message: SECRET },
    });
    await t.close();
  });

  it('applies the schedule’s own roles and its report’s roles on top of Operator', async () => {
    const { t, run, admin } = await setup(failed);
    await run('reports.admin-schedule');
    await run('reports.admin-report');
    const op = await t.login(AVERY, OPERATOR);
    for (const key of ['reports.admin-schedule', 'reports.admin-report']) {
      const seen = await history(op, key);
      expect(seen.error, key).toEqual({
        code: 'run_failed',
        message: expect.stringContaining('Portal.Admin'),
      });
      expect(seen.runId, key).toBeUndefined();
      expect(await history(admin, key), key).toMatchObject({ runId: RUN_ID, error: { message: SECRET } });
    }
    await t.close();
  });

  it('keeps a job error’s hint from a Reader too', async () => {
    const { t, run } = await setup(() => {
      throw new AppError(502, 'upstream_error', SECRET, {
        hint: 'Check finance-ceo@example.com permissions.',
      });
    });
    await run('reports.probe-sweep');
    const reader = await t.login(READER, ['Portal.Reader']);
    const seen = await history(reader, 'reports.probe-sweep');
    expect(seen.error).toEqual({ code: 'upstream_error', message: expect.any(String) });
    expect(JSON.stringify(seen)).not.toContain('finance-ceo');
    await t.close();
  });

  it('broadcasts schedule.failed with metadata only', async () => {
    const { t, run, events } = await setup(failed);
    await run('reports.probe-sweep');
    const e = events.find((x) => x.type === 'schedule.failed');
    expect(e?.data).toEqual({
      key: 'reports.probe-sweep',
      scheduleRunId: expect.any(String),
      status: 'failed',
      error: { code: 'run_failed' },
    });
    await t.close();
  });
});

describe('schedule scaffold respects the definition’s roles', () => {
  const body = (job: Record<string, unknown>) => ({
    title: 'Copied',
    cron: '0 6 * * 1',
    timezone: 'UTC',
    job,
  });

  it('refuses a Reader the requirements of an Operator playbook or an Admin report, as the definitions route does', async () => {
    const { t } = await setup(failed);
    const reader = await t.login(READER, ['Portal.Reader']);
    const playbook = await reader.post(
      '/api/schedules/scaffold',
      body({ kind: 'playbook', ref: 'identity.operator-check', mode: 'read' }),
    );
    expect(playbook.statusCode).toBe(403);
    expect(playbook.json().error).toMatchObject({
      code: 'forbidden',
      message: 'This playbook needs the Portal.Operator role.',
    });
    expect(playbook.body).not.toContain('User.Read.All');
    const report = await reader.post(
      '/api/schedules/scaffold',
      body({ kind: 'report', ref: 'identity.admin-only', format: 'xlsx' }),
    );
    expect(report.statusCode).toBe(403);
    expect(report.body).not.toContain('AuditLog.Read.All');
    const direct = await reader.get('/api/definitions/playbook/identity.operator-check');
    expect(direct.statusCode).toBe(403);
    await t.close();
  });

  it('still scaffolds for someone who holds the roles', async () => {
    const { t } = await setup(failed);
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post(
      '/api/schedules/scaffold',
      body({ kind: 'playbook', ref: 'identity.operator-check', mode: 'read' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().yaml).toContain('User.Read.All');
    await t.close();
  });
});
