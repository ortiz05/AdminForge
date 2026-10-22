import { Schedule } from '@adminforge/schemas';
import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  FakeDefinitions,
  READER,
  schedule,
  schedulesApp,
} from './schedules-helpers';

// What each viewer reads in a schedule's run history (GET /api/schedules/:key/runs). Run rows are inserted directly:
// the scheduler's own messages (a missed run, a timeout) stay for everyone; a job's error message and the run id are
// for the roles that may see the schedule's data — including its playbook's own roles — and, for a schedule that
// runs with its creator's access, for the creator and Portal Admins only. No file link is offered to someone who
// may not open the file.
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const RUN_ID = '00000000-0000-4000-8000-0000000000bb';
const plainReport = {
  kind: 'report' as const,
  id: 'identity.plain',
  version: '1.0.0',
  title: 'Plain report',
  owner: 'identity-team',
  export: { formats: ['csv'] },
};
const adminPlaybook = {
  kind: 'playbook' as const,
  id: 'identity.admin-check',
  version: '1.0.0',
  title: 'Admin check',
  mode: 'read',
  requires: { portalRoles: ['Portal.Admin'] },
  steps: [],
};

async function setup() {
  const defs = new FakeDefinitions()
    .set(plainReport)
    .set(adminPlaybook)
    .set(schedule('reports.sweep'))
    .set(
      schedule('reports.admin-playbook', {
        job: { kind: 'playbook', ref: 'identity.admin-check', mode: 'read' },
      }),
    );
  const t = await schedulesApp({ defs });
  const admin = await t.login(BLAKE, ALL_ROLES);
  await admin.get('/api/schedules'); // syncs content schedules into the store
  const insert = async (key: string, run: Record<string, unknown>) => {
    const row = (await t.schedules.store.getSchedule(key))!;
    await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'cron',
      startedAt: new Date(Date.UTC(2026, 9, 15, 6)),
      endedAt: new Date(Date.UTC(2026, 9, 15, 6, 1)),
      ...run,
    } as never);
  };
  const first = async (who: { get(url: string): Promise<{ json(): unknown }> }, key: string) =>
    ((await who.get(`/api/schedules/${key}/runs`)).json() as { items: Array<Record<string, unknown>> })
      .items[0]!;
  return { t, admin, insert, first };
}

describe('schedule run history by viewer', () => {
  it('keeps the scheduler’s own messages for a Reader', async () => {
    const { t, insert, first } = await setup();
    await insert('reports.sweep', {
      status: 'skipped',
      error: {
        code: 'schedule_missed',
        message: 'This run was due at 06:00 while AdminForge was not running.',
      },
      result: { reason: 'This run was due at 06:00 while AdminForge was not running.' },
    });
    const reader = await t.login(READER, ['Portal.Reader']);
    expect(await first(reader, 'reports.sweep')).toMatchObject({
      status: 'skipped',
      error: {
        code: 'schedule_missed',
        message: 'This run was due at 06:00 while AdminForge was not running.',
      },
    });
    await t.close();
  });

  it('applies the playbook’s own roles: an Operator gets the code only, an Admin everything', async () => {
    const { t, admin, insert, first } = await setup();
    await insert('reports.admin-playbook', {
      status: 'failed',
      runId: RUN_ID,
      error: { code: 'run_failed', message: 'Group SG-Finance-Payroll: access denied' },
    });
    const op = await t.login(AVERY, OPERATOR);
    const seen = await first(op, 'reports.admin-playbook');
    expect(seen.error).toEqual({
      code: 'run_failed',
      message: 'The details are shown only to people with the Portal.Operator and Portal.Admin role.',
    });
    expect(seen.runId).toBeUndefined();
    expect(await first(admin, 'reports.admin-playbook')).toMatchObject({
      runId: RUN_ID,
      error: { message: 'Group SG-Finance-Payroll: access denied' },
    });
    await t.close();
  });

  it('offers no file link to someone who may not open the file', async () => {
    const { t, admin, insert, first } = await setup();
    await insert('reports.sweep', { status: 'succeeded', artifactPath: 'reports.sweep/2026-10-15.csv' });
    const reader = await t.login(READER, ['Portal.Reader']);
    expect((await first(reader, 'reports.sweep')).artifact).toBeUndefined();
    expect((await first(admin, 'reports.sweep')).artifact).toMatchObject({
      href: expect.stringMatching(/^\/api\/artifacts\//),
    });
    await t.close();
  });

  it('shows a creator schedule’s error only to its creator and Portal Admins', async () => {
    const { t, admin, first } = await setup();
    const key = 'portal.identity-plain-c0ffee';
    const row = (await t.schedules.store.insertSchedule({
      key,
      source: 'portal',
      definition: Schedule.parse({
        kind: 'schedule',
        id: key,
        version: '1.0.0',
        title: 'Plain, with my access',
        owner: AVERY.upn,
        cron: '0 6 * * 1',
        identity: { user: 'creator' },
        job: { kind: 'report', ref: 'identity.plain', delivery: [{ type: 'file', format: 'csv' }] },
        requires: { portalRoles: ['Portal.Operator'] },
      }),
      sha256: 'sha-creator',
      enabled: true,
      nextRunAt: null,
      createdBy: AVERY.oid,
    }))!;
    await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'cron',
      status: 'failed',
      startedAt: new Date(Date.UTC(2026, 9, 15, 6)),
      endedAt: new Date(Date.UTC(2026, 9, 15, 6, 1)),
      error: { code: 'upstream_error', message: 'Mailbox ceo@example.com: access denied' },
    } as never);
    const other = await t.login(
      { ...AVERY, oid: '00000000-0000-4000-8000-0000000000d9', upn: 'other@example.com' } as never,
      OPERATOR,
    );
    expect((await first(other, key)).error).toEqual({
      code: 'upstream_error',
      message:
        'The details are shown only to the person who created this schedule and portal administrators.',
    });
    const creator = await t.login(AVERY, OPERATOR);
    expect((await first(creator, key)).error).toMatchObject({
      message: 'Mailbox ceo@example.com: access denied',
    });
    expect((await first(admin, key)).error).toMatchObject({
      message: 'Mailbox ceo@example.com: access denied',
    });
    await t.close();
  });
});
