import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiErrorBody } from '@adminforge/schemas';
import { flush } from '../unit/scheduler/helpers';
import { FakeJobs, schedule } from './schedules-helpers';
import {
  ADMIN,
  AVERY,
  BLAKE,
  DANA,
  OPERATOR,
  READER,
  body,
  contentSchedule,
  portalApp,
  reportDefs,
} from './portal-schedules-helpers';

// Editing and deleting report schedules created in the portal: the creator (by oid) or a Portal.Admin; any Operator
// may still turn one off or run it now; content schedules change only through their YAML.

const error = (res: { json(): unknown }) => ApiErrorBody.parse(res.json()).error;

async function withSchedule(o: Parameters<typeof portalApp>[0] = {}) {
  const t = await portalApp(o);
  const creator = await t.login(AVERY, OPERATOR);
  const created = await creator.post('/api/schedules', body({}, { params: { days: 30 } }));
  expect(created.statusCode).toBe(201);
  return { t, creator, key: created.json().key as string };
}

describe('PUT /api/schedules/:key', () => {
  it('the creator saves a new version: patch bump, new sha256, enabled kept, next run recomputed, audited', async () => {
    const { t, creator, key } = await withSchedule();
    const before = (await t.schedules.store.getSchedule(key))!;
    const res = await creator.put(
      `/api/schedules/${key}`,
      body(
        { title: 'Inactive users, daily', cron: '30 7 * * *', timezone: 'UTC', enabled: false },
        { format: 'csv', retain: 10, params: { days: 90 }, emailKey: 'AF_REPORT_RECIPIENTS' },
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      key,
      title: 'Inactive users, daily',
      cron: '30 7 * * *',
      // `enabled` in the body is ignored: the toggle owns it.
      enabled: true,
      nextRunAt: '2026-10-16T07:30:00.000Z',
      job: { kind: 'report', ref: 'identity.inactive-users', params: { days: 90 } },
      delivery: [
        { type: 'file', format: 'csv', retain: 10 },
        { type: 'email', key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients', format: 'csv' },
      ],
      createdBy: 'avery@example.com',
      canManage: true,
    });
    const after = (await t.schedules.store.getSchedule(key))!;
    expect(after.definition).toMatchObject({ version: '1.0.1', owner: 'avery@example.com', enabled: true });
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.createdBy).toBe(AVERY.oid);
    expect(t.audit.rows.find((r) => r.action === 'schedule.updated')).toMatchObject({
      actorUpn: 'avery@example.com',
      targetId: key,
      details: {
        version: '1.0.1',
        previousVersion: '1.0.0',
        cron: '30 7 * * *',
        format: 'csv',
        params: { days: 90 },
      },
    });
    await t.close();
  });

  it('a Portal.Admin may edit it too (the owner stays the creator)', async () => {
    const { t, key } = await withSchedule();
    const admin = await t.login(DANA, ADMIN);
    expect((await admin.get(`/api/schedules/${key}`)).json().canManage).toBe(true);
    const res = await admin.put(`/api/schedules/${key}`, body({ title: 'Renamed by an admin' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Renamed by an admin',
      createdBy: 'avery@example.com',
      canManage: true,
    });
    expect((await t.schedules.store.getSchedule(key))!.definition.owner).toBe('avery@example.com');
    await t.close();
  });

  it('another Operator may not edit or delete it, but may turn it off and run it now', async () => {
    const jobs = new FakeJobs(() => ({ result: { ok: true } }));
    const { t, key } = await withSchedule({ jobs, inProcess: true });
    const other = await t.login(BLAKE, OPERATOR);
    for (const res of [
      await other.put(`/api/schedules/${key}`, body({ title: 'Mine now' })),
      await other.del(`/api/schedules/${key}`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(error(res)).toMatchObject({
        code: 'forbidden',
        message:
          'Only the person who created this schedule or a portal administrator can change or delete it.',
        hint: expect.stringContaining('avery@example.com'),
      });
    }
    // The existing toggle and Run now work on portal rows.
    expect((await other.patch(`/api/schedules/${key}`, { enabled: false })).json()).toEqual({
      key,
      enabled: false,
    });
    expect((await other.get(`/api/schedules/${key}`)).json()).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect((await other.patch(`/api/schedules/${key}`, { enabled: true })).json()).toEqual({
      key,
      enabled: true,
    });
    const run = await other.post(`/api/schedules/${key}/run`);
    expect(run.statusCode).toBe(202);
    await flush();
    await t.clock.advance(1);
    await t.schedules.scheduler!.drain();
    expect(jobs.calls.map((c) => [c.schedule.key, c.scheduledBy])).toEqual([[key, 'blake@example.com']]);
    expect((await other.get(`/api/schedules/${key}/runs`)).json().items[0]).toMatchObject({
      id: run.json().scheduleRunId,
      trigger: 'manual',
      status: 'succeeded',
    });
    await t.close();
  });

  it('refuses a different report, a non-report job, a Reader and an unknown key', async () => {
    const { t, creator, key } = await withSchedule();
    const other = await creator.put(`/api/schedules/${key}`, body({}, { ref: 'azure.monthly-cost' }));
    expect(other.statusCode).toBe(400);
    expect(error(other)).toMatchObject({
      code: 'report_cannot_change',
      message: 'A schedule always runs the same report.',
    });
    const probe = await creator.put(`/api/schedules/${key}`, body({ job: { kind: 'probe', tags: ['x'] } }));
    expect(error(probe).code).toBe('job_not_allowed');
    const tooOften = await creator.put(`/api/schedules/${key}`, body({ cron: '*/5 * * * *' }));
    expect(error(tooOften).code).toBe('cron_too_frequent');
    const reader = await t.login(READER, ['Portal.Reader']);
    expect((await reader.put(`/api/schedules/${key}`, body())).statusCode).toBe(403);
    expect((await reader.del(`/api/schedules/${key}`)).statusCode).toBe(403);
    expect((await creator.put('/api/schedules/portal.nope-123456', body())).statusCode).toBe(404);
    expect((await creator.del('/api/schedules/portal.nope-123456')).statusCode).toBe(404);
    expect((await t.schedules.store.getSchedule(key))!.definition.version).toBe('1.0.0');
    await t.close();
  });

  it('content schedules are changed through their YAML (409 schedule_is_content), even for an Admin', async () => {
    const t = await portalApp();
    const admin = await t.login(DANA, ADMIN);
    const key = contentSchedule.id;
    for (const res of [
      await admin.put(`/api/schedules/${key}`, body()),
      await admin.del(`/api/schedules/${key}`),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(error(res)).toMatchObject({
        code: 'schedule_is_content',
        message: 'This schedule is defined in content; change its YAML and publish it.',
      });
    }
    expect((await admin.get(`/api/schedules/${key}`)).json()).toMatchObject({
      source: 'content',
      createdBy: null,
      canManage: false,
      delivery: [
        { type: 'file', format: 'xlsx', retain: 12 },
        { type: 'email', key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients', format: 'xlsx' },
      ],
    });
    await t.close();
  });
});

describe('DELETE /api/schedules/:key', () => {
  it('soft-deletes: hidden (404) afterwards, row and history kept, queued runs cancelled, audited', async () => {
    const { t, creator, key } = await withSchedule();
    const row = (await t.schedules.store.getSchedule(key))!;
    // A finished run with a file, and a run still queued (run now before the scheduler picked it up).
    mkdirSync(path.join(t.artifactsDir, key), { recursive: true });
    writeFileSync(path.join(t.artifactsDir, key, '2026-10-15T06-00-00Z.csv'), 'Name\r\nsynthetic\r\n');
    const done = await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'cron',
      status: 'succeeded',
      artifactPath: `${key}/2026-10-15T06-00-00Z.csv`,
      startedAt: new Date('2026-10-15T06:00:00Z'),
      endedAt: new Date('2026-10-15T06:01:00Z'),
    });
    const queued = (await creator.post(`/api/schedules/${key}/run`)).json().scheduleRunId as string;

    const res = await creator.del(`/api/schedules/${key}`);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // Gone from the API …
    expect((await creator.get(`/api/schedules/${key}`)).statusCode).toBe(404);
    expect((await creator.get(`/api/schedules/${key}/runs`)).statusCode).toBe(404);
    expect((await creator.patch(`/api/schedules/${key}`, { enabled: true })).statusCode).toBe(404);
    expect((await creator.post(`/api/schedules/${key}/run`)).statusCode).toBe(404);
    expect((await creator.del(`/api/schedules/${key}`)).statusCode).toBe(404);
    expect(
      (await creator.get('/api/schedules')).json().items.map((i: { key: string }) => i.key),
    ).not.toContain(key);
    const catalogue = (await creator.get('/api/reports'))
      .json()
      .items.find((i: { key: string }) => i.key === 'identity.inactive-users');
    expect(catalogue.schedules.map((s: { key: string }) => s.key)).toEqual(['reports.inactive-users-weekly']);

    // … but kept in the store: retired, off, with its history; the queued run will never start.
    const kept = (await t.schedules.store.getSchedule(key))!;
    expect(kept).toMatchObject({ source: 'portal', enabled: false, nextRunAt: null });
    expect(kept.definition.status).toBe('retired');
    expect(await t.schedules.store.getRun(done.id)).toMatchObject({ status: 'succeeded' });
    expect(await t.schedules.store.getRun(queued)).toMatchObject({
      status: 'skipped',
      result: expect.objectContaining({ reason: 'The schedule was deleted before this run started.' }),
    });
    expect(t.audit.rows.find((r) => r.action === 'schedule.deleted')).toMatchObject({
      actorUpn: 'avery@example.com',
      targetId: key,
      details: { report: 'identity.inactive-users', wasEnabled: true, cancelledRuns: 1 },
    });

    // The file stays downloadable until retention, still behind the schedule's and the report's roles.
    const reader = await t.login(READER, ['Portal.Reader']);
    expect((await reader.get(`/api/artifacts/${done.id}`)).statusCode).toBe(403);
    const download = await creator.get(`/api/artifacts/${done.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain('synthetic');
    await t.close();
  });

  it('a Portal.Admin may delete any portal schedule; new keys are never reused', async () => {
    const { t, creator, key } = await withSchedule();
    const admin = await t.login(DANA, ADMIN);
    expect((await admin.del(`/api/schedules/${key}`)).statusCode).toBe(204);
    const again = await creator.post('/api/schedules', body());
    expect(again.statusCode).toBe(201);
    expect(again.json().key).not.toBe(key);
    await t.close();
  });

  it('the scheduler never runs a deleted schedule, not even a run queued before the delete', async () => {
    const jobs = new FakeJobs();
    const t = await portalApp({ jobs, inProcess: true });
    const op = await t.login(AVERY, OPERATOR);
    const key = (await op.post('/api/schedules', body({ cron: '0 * * * *', timezone: 'UTC' }))).json()
      .key as string;
    const row = (await t.schedules.store.getSchedule(key))!;
    // Simulate a queued retry that slipped in before the delete (not cancelled by the API).
    await op.del(`/api/schedules/${key}`);
    const retry = await t.schedules.store.insertRun({
      scheduleId: row.id,
      scheduleKey: key,
      trigger: 'manual',
      status: 'queued',
      startedAt: t.clock.now(),
    });
    // … and a toggle that raced the delete (enabled again, due now).
    await t.schedules.store.updateSchedule(row.id, { enabled: true, nextRunAt: t.clock.now() });
    t.schedules.scheduler!.wake();
    await flush();
    await t.clock.advance(2 * 3_600_000);
    await t.schedules.scheduler!.drain();
    expect(jobs.calls).toEqual([]);
    expect(await t.schedules.store.getRun(retry.id)).toMatchObject({ status: 'skipped' });
    expect(await t.schedules.store.getSchedule(key)).toMatchObject({ enabled: false, nextRunAt: null });
    await t.close();
  });
});

describe('content sync and portal schedules', () => {
  it('never touches portal rows when content changes or a content schedule disappears', async () => {
    const defs = reportDefs();
    const { t, creator, key } = await withSchedule({ defs });
    await creator.patch(`/api/schedules/${key}`, { enabled: false });
    const before = (await t.schedules.store.getSchedule(key))!;
    defs.set(schedule('reports.another', { cron: '0 8 * * *', job: contentSchedule.job }));
    defs.remove('schedule', contentSchedule.id);
    const listed = (await creator.get('/api/schedules')).json().items.map((i: { key: string }) => i.key);
    expect(listed).toEqual([key, 'reports.another']);
    const after = (await t.schedules.store.getSchedule(key))!;
    expect(after).toEqual(before);
    await t.close();
  });
});
