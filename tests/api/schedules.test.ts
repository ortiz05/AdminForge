import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { flush } from '../support/scheduler';
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

const WRITE_JOB = {
  job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
};

/** The playbook the write schedule runs: approvals cover its fingerprint (runs/fingerprint.ts). */
const disableUser = (version = '1.0.0') => ({
  kind: 'playbook' as const,
  id: 'identity.disable-user',
  version,
  title: 'Disable sign-in',
  mode: 'write',
  steps: [],
});

function content() {
  return new FakeDefinitions()
    .set(disableUser())
    .set(
      schedule('sweep.every-15-minutes', {
        job: { kind: 'probe', select: { tags: ['sweep-15m'] } },
        summary: 'Probe sweep',
      }),
    )
    .set(
      schedule('reports.weekly', {
        cron: '0 7 * * 1',
        timezone: 'Europe/London',
        enabled: false,
        job: { kind: 'report', ref: 'azure.example', delivery: [{ type: 'file', format: 'csv' }] },
      }),
    )
    .set(schedule('ops.disable-stale', { cron: '0 3 * * *', ...WRITE_JOB }));
}

describe('schedules API', () => {
  it('lists content schedules with their operational state', async () => {
    const t = await schedulesApp({ defs: content() });
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get('/api/schedules');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.key)).toEqual([
      'ops.disable-stale',
      'reports.weekly',
      'sweep.every-15-minutes',
    ]);
    expect(items.find((i) => i.key === 'sweep.every-15-minutes')).toEqual({
      key: 'sweep.every-15-minutes',
      title: 'Schedule sweep.every-15-minutes',
      summary: 'Probe sweep',
      cron: '*/15 * * * *',
      cronText: 'Every 15 minutes (UTC)',
      timezone: 'UTC',
      enabled: true,
      identity: 'automation',
      job: { kind: 'probe', select: { tags: ['sweep-15m'] } },
      nextRunAt: '2026-10-15T12:15:00.000Z',
      lastRunAt: null,
      lastStatus: null,
      writeCapable: false,
      source: 'content',
      createdBy: null,
      canManage: false,
      pendingApprovalId: null,
    });
    expect(items.find((i) => i.key === 'reports.weekly')).toMatchObject({
      enabled: false,
      nextRunAt: null,
      cronText: 'Every Monday at 07:00 Europe/London',
      timezone: 'Europe/London',
      job: { kind: 'report', ref: 'azure.example' },
    });
    expect(items.find((i) => i.key === 'ops.disable-stale')).toMatchObject({
      enabled: false,
      writeCapable: true,
      job: { kind: 'playbook', ref: 'identity.disable-user' },
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/schedules' })).statusCode).toBe(401);
    await t.close();
  });

  it('lets an operator enable and disable read-only schedules (audited); readers cannot', async () => {
    const t = await schedulesApp({ defs: content() });
    const reader = await t.login(READER, ['Portal.Reader']);
    const op = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    expect((await reader.patch('/api/schedules/reports.weekly', { enabled: true })).json().error.code).toBe(
      'forbidden',
    );
    const on = await op.patch('/api/schedules/reports.weekly', { enabled: true });
    expect([on.statusCode, on.json()]).toEqual([200, { key: 'reports.weekly', enabled: true }]);
    const item = (await op.get('/api/schedules'))
      .json()
      .items.find((i: { key: string }) => i.key === 'reports.weekly');
    expect(item).toMatchObject({ enabled: true, nextRunAt: '2026-10-19T06:00:00.000Z' });
    const off = await op.patch('/api/schedules/reports.weekly', { enabled: false });
    expect(off.json()).toEqual({ key: 'reports.weekly', enabled: false });
    expect(
      t.audit.rows.filter((r) => r.targetId === 'reports.weekly').map((r) => [r.action, r.actorUpn]),
    ).toEqual([
      ['schedule.enabled', 'avery@example.com'],
      ['schedule.disabled', 'avery@example.com'],
    ]);
    expect((await op.patch('/api/schedules/nope.missing', { enabled: true })).statusCode).toBe(404);
    expect((await op.patch('/api/schedules/reports.weekly', { enabled: 'yes' })).statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: '/api/schedules/reports.weekly',
          headers: { cookie: op.headers.cookie },
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(403);
    await t.close();
  });

  it('needs a second person to enable a write-capable schedule', async () => {
    const t = await schedulesApp({ defs: content() });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ALL_ROLES);
    const req = await avery.patch('/api/schedules/ops.disable-stale', { enabled: true });
    expect(req.statusCode).toBe(202);
    const { approvalId } = req.json();
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).json()).toEqual({
      approvalId,
    });
    const listed = (await avery.get('/api/schedules'))
      .json()
      .items.find((i: { key: string }) => i.key === 'ops.disable-stale');
    expect(listed).toMatchObject({ enabled: false, pendingApprovalId: approvalId });
    // Not runnable until approved.
    expect((await avery.post('/api/schedules/ops.disable-stale/run')).json().error.code).toBe(
      'approval_required',
    );

    const inbox = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(inbox).toEqual([
      expect.objectContaining({
        id: approvalId,
        subjectType: 'schedule',
        subjectId: 'ops.disable-stale',
        stepId: null,
        kind: 'approval',
        status: 'pending',
        requestedBy: 'avery@example.com',
        canDecide: true,
        policy: expect.objectContaining({ writesAfter: false, approvers: ['Playbook.Approver'] }),
      }),
    ]);
    expect((await avery.get('/api/approvals?status=pending')).json().items[0].canDecide).toBe(false);
    expect(
      (await avery.post(`/api/approvals/${approvalId}`, { decision: 'approve' })).json().error.code,
    ).toBe('own_request');

    const decided = await blake.post(`/api/approvals/${approvalId}`, {
      decision: 'approve',
      comment: 'Reviewed the playbook.',
    });
    expect(decided.json()).toEqual({ status: 'approved', approvals: 1, required: 1 });
    const enabled = (await avery.get('/api/schedules'))
      .json()
      .items.find((i: { key: string }) => i.key === 'ops.disable-stale');
    expect(enabled).toMatchObject({
      enabled: true,
      approvedBy: ['blake@example.com'],
      pendingApprovalId: null,
      nextRunAt: '2026-10-16T03:00:00.000Z',
    });
    expect(
      (await blake.post(`/api/approvals/${approvalId}`, { decision: 'approve' })).json().error.code,
    ).toBe('already_decided');
    expect(t.audit.rows.find((r) => r.action === 'schedule.approved')).toMatchObject({
      actorUpn: 'blake@example.com',
      targetId: 'ops.disable-stale',
      details: expect.objectContaining({ requestedBy: 'avery@example.com', enabled: true }),
    });

    // Disabling clears the approval: enabling again needs a new one.
    await avery.patch('/api/schedules/ops.disable-stale', { enabled: false });
    expect((await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).statusCode).toBe(202);
    await t.close();
  });

  it('rejecting leaves the schedule disabled; unknown approvals are 404', async () => {
    const t = await schedulesApp({ defs: content() });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ['Portal.Reader', 'Playbook.Approver']);
    const { approvalId } = (await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).json();
    expect(
      (await blake.post(`/api/approvals/${approvalId}`, { decision: 'reject', comment: 'Too broad' })).json(),
    ).toMatchObject({ status: 'rejected' });
    expect(
      (await avery.get('/api/schedules'))
        .json()
        .items.find((i: { key: string }) => i.key === 'ops.disable-stale'),
    ).toMatchObject({ enabled: false, pendingApprovalId: null });
    expect(
      (await blake.post('/api/approvals/00000000-0000-4000-8000-000000000999', { decision: 'approve' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await blake.get('/api/approvals?status=rejected')).json().items.map((i: { id: string }) => i.id),
    ).toEqual([approvalId]);
    await t.close();
  });

  it('an approval no longer applies once the definition changed', async () => {
    const defs = content();
    const t = await schedulesApp({ defs });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ALL_ROLES);
    const { approvalId } = (await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).json();
    defs.set(schedule('ops.disable-stale', { cron: '0 4 * * *', ...WRITE_JOB }));
    await avery.get('/api/schedules');
    expect(
      (await blake.post(`/api/approvals/${approvalId}`, { decision: 'approve' })).json().error.code,
    ).toBe('definition_changed');
    await t.close();
  });

  it('runs a schedule now through the in-process scheduler and shows it in the history', async () => {
    const jobs = new FakeJobs(() => ({ result: { probes: 2, ok: 2, warn: 0, crit: 0, error: 0 } }));
    const t = await schedulesApp({ defs: content(), jobs, inProcess: true });
    const op = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    const reader = await t.login(READER, ['Portal.Reader']);
    expect((await reader.post('/api/schedules/sweep.every-15-minutes/run')).statusCode).toBe(403);
    const res = await op.post('/api/schedules/sweep.every-15-minutes/run');
    expect(res.statusCode).toBe(202);
    const { scheduleRunId } = res.json();
    await flush();
    await t.clock.advance(1);
    await t.schedules.scheduler!.drain();
    const runs = (await reader.get('/api/schedules/sweep.every-15-minutes/runs')).json();
    expect(runs.items).toEqual([
      {
        id: scheduleRunId,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: '2026-10-15T12:00:00.000Z',
        endedAt: expect.any(String),
      },
    ]);
    expect(jobs.calls[0]!.scheduledBy).toBe('avery@example.com');
    expect(t.audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['schedule.run_requested', 'schedule.run']),
    );
    expect(t.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      summary: 'Scheduled by avery@example.com, executed as automation identity.',
    });
    expect(
      (await reader.get('/api/schedules'))
        .json()
        .items.find((i: { key: string }) => i.key === 'sweep.every-15-minutes'),
    ).toMatchObject({ lastStatus: 'succeeded', lastRunAt: '2026-10-15T12:00:00.000Z' });
    await t.close();
  });

  it('pages the run history with a cursor', async () => {
    const t = await schedulesApp({ defs: content() });
    const reader = await t.login(READER, ['Portal.Reader']);
    await reader.get('/api/schedules');
    const row = (await t.schedules.store.getSchedule('sweep.every-15-minutes'))!;
    for (let i = 0; i < 5; i++)
      await t.schedules.store.insertRun({
        scheduleId: row.id,
        scheduleKey: row.key,
        trigger: 'cron',
        status: i === 4 ? 'failed' : 'succeeded',
        startedAt: new Date(Date.UTC(2026, 9, 15, i)),
        endedAt: new Date(Date.UTC(2026, 9, 15, i, 1)),
        ...(i === 4 ? { error: { code: 'upstream_error', message: 'Graph returned 503' } } : {}),
      });
    const first = (await reader.get('/api/schedules/sweep.every-15-minutes/runs?limit=2')).json();
    expect(first.items.map((r: { startedAt: string }) => r.startedAt)).toEqual([
      '2026-10-15T04:00:00.000Z',
      '2026-10-15T03:00:00.000Z',
    ]);
    expect(first.items[0]).toMatchObject({
      status: 'failed',
      error: { code: 'upstream_error', message: 'Graph returned 503' },
    });
    const second = (
      await reader.get(`/api/schedules/sweep.every-15-minutes/runs?limit=2&cursor=${first.cursor}`)
    ).json();
    expect(second.items.map((r: { startedAt: string }) => r.startedAt)).toEqual([
      '2026-10-15T02:00:00.000Z',
      '2026-10-15T01:00:00.000Z',
    ]);
    const last = (
      await reader.get(`/api/schedules/sweep.every-15-minutes/runs?limit=2&cursor=${second.cursor}`)
    ).json();
    expect([last.items.length, last.cursor]).toEqual([1, undefined]);
    expect((await reader.get('/api/schedules/sweep.every-15-minutes/runs?cursor=garbage')).statusCode).toBe(
      400,
    );
    expect((await reader.get('/api/schedules/nope.x/runs')).statusCode).toBe(404);
    await t.close();
  });

  it('downloads a run report file (path-safe, audited)', async () => {
    const t = await schedulesApp({ defs: content() });
    // Scheduled reports hold data collected with application permissions: Operators by default (SCHEDULED_DATA_ROLES).
    const readerOnly = await t.login(AVERY, ['Portal.Reader']);
    const reader = await t.login(READER, ['Portal.Reader', 'Portal.Operator']);
    await reader.get('/api/schedules');
    const row = (await t.schedules.store.getSchedule('reports.weekly'))!;
    mkdirSync(path.join(t.artifactsDir, 'reports.weekly'), { recursive: true });
    writeFileSync(path.join(t.artifactsDir, 'reports.weekly', '2026-10-15T06-00-00Z.csv'), 'Name\r\nsa1\r\n');
    const ok = await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'cron',
      status: 'succeeded',
      artifactPath: 'reports.weekly/2026-10-15T06-00-00Z.csv',
      result: {
        artifacts: [
          {
            path: 'reports.weekly/2026-10-15T06-00-00Z.csv',
            name: 'reports.weekly-2026-10-15T06-00-00Z.csv',
            size: 11,
          },
        ],
      },
    });
    const evil = await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'cron',
      status: 'succeeded',
      artifactPath: '../../../etc/passwd',
    });

    const runs = (await reader.get('/api/schedules/reports.weekly/runs')).json().items;
    expect(runs.find((r: { id: string }) => r.id === ok.id).artifact).toEqual({
      name: 'reports.weekly-2026-10-15T06-00-00Z.csv',
      href: `/api/artifacts/${ok.id}`,
      size: 11,
    });
    const denied = await readerOnly.get(`/api/artifacts/${ok.id}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/Portal\.Operator/);
    const file = await reader.get(`/api/artifacts/${ok.id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.headers['content-disposition']).toMatch(
      /^attachment; filename="reports.weekly-2026-10-15T06-00-00Z.csv"/,
    );
    expect(file.body).toBe('Name\r\nsa1\r\n');
    expect(t.audit.rows.find((r) => r.action === 'artifact.downloaded')).toMatchObject({
      targetId: ok.id,
      actorUpn: READER.upn,
    });
    for (const id of [
      evil.id,
      '00000000-0000-4000-8000-000000000999',
      'not-a-uuid',
      '..%2F..%2Fetc%2Fpasswd',
    ])
      expect((await reader.get(`/api/artifacts/${id}`)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/artifacts/${ok.id}` })).statusCode).toBe(401);
    await t.close();
  });
});
