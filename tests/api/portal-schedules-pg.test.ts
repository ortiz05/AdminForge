import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import { ScheduleEvents } from '@adminforge/api/src/schedules/events';
import { PgScheduleStore } from '@adminforge/api/src/schedules/pg-store';
import { PortalSchedules } from '@adminforge/api/src/schedules/portal';
import { ScheduleService, type Caller } from '@adminforge/api/src/schedules/service';
import { testDatabaseUrl } from './db';
import { AVERY, BLAKE, DELIVERY_ENV, OPERATOR, body, reportDefs } from './portal-schedules-helpers';

// Report schedules created in the portal on Postgres: the row (source, creator, definition) round-trips, edits are
// guarded by the definition's sha256, deleting retires the row and skips its queued runs.

const url = await testDatabaseUrl();
const NOW = new Date('2026-10-15T12:00:00.000Z');

const caller = (user: { oid: string; upn: string }, roles = OPERATOR): Caller => ({
  session: { userOid: user.oid, upn: user.upn, idHash: `h-${user.oid}`, roles } as SessionRecord,
  correlationId: 'corr-1',
  ip: '127.0.0.1',
});

describe.skipIf(!url)('portal report schedules on Postgres', () => {
  let db: Database;
  let dir: string;
  let store: PgScheduleStore;
  let portal: PortalSchedules;
  let service: ScheduleService;
  const audit = new MemoryAuditWriter(() => NOW);

  beforeAll(() => {
    db = createDatabase(url!);
    store = new PgScheduleStore(db.db);
    dir = mkdtempSync(path.join(tmpdir(), 'af-portal-pg-'));
    const defs = reportDefs();
    service = new ScheduleService({
      store,
      definitions: defs,
      audit,
      events: new ScheduleEvents(),
      artifacts: new ArtifactStore(dir),
      now: () => NOW,
    });
    portal = new PortalSchedules({
      service,
      store,
      definitions: registryFrom(defs as never, 'fs'),
      datasources: { prepareParams: async (_page, raw) => ({ ...raw }) },
      audit,
      deliveryEnv: () => DELIVERY_ENV,
      now: () => NOW,
    });
  });
  beforeEach(async () => {
    await db.pool.query('truncate schedules, schedule_runs cascade');
  });
  afterAll(async () => {
    await db.pool.query('truncate schedules, schedule_runs cascade');
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, edits and soft-deletes a portal schedule', async () => {
    const created = await portal.create(
      caller(AVERY),
      body({}, { params: { days: 90 }, emailKey: 'AF_REPORT_RECIPIENTS' }),
    );
    const { rows } = await db.pool.query<{
      source: string;
      created_by: string;
      enabled: boolean;
      owner: string;
      ref: string;
    }>(
      "select source, created_by, enabled, definition->>'owner' as owner, definition->'job'->>'ref' as ref from schedules where key = $1",
      [created.key],
    );
    expect(rows).toEqual([
      {
        source: 'portal',
        created_by: AVERY.oid,
        enabled: true,
        owner: 'avery@example.com',
        ref: 'identity.inactive-users',
      },
    ]);
    expect(
      (await service.list(caller(BLAKE).session)).items.find((i) => i.key === created.key),
    ).toMatchObject({
      source: 'portal',
      createdBy: 'avery@example.com',
      canManage: false,
      job: { params: { days: 90 } },
    });

    const saved = await portal.update(caller(AVERY), created.key, body({ title: 'Renamed' }));
    expect(saved.title).toBe('Renamed');
    expect((await store.getSchedule(created.key))!.definition.version).toBe('1.0.1');

    const row = (await store.getSchedule(created.key))!;
    const queued = await store.insertRun({
      scheduleId: row.id,
      scheduleKey: row.key,
      trigger: 'manual',
      status: 'queued',
      startedAt: NOW,
    });
    await portal.remove(caller(AVERY), created.key);
    expect(await store.getSchedule(created.key)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await store.getSchedule(created.key))!.definition.status).toBe('retired');
    expect(await store.getRun(queued.id)).toMatchObject({ status: 'skipped' });
    expect((await service.list()).items.map((i) => i.key)).not.toContain(created.key);
    await expect(service.get(created.key)).rejects.toMatchObject({ code: 'schedule_not_found' });
  });
});
