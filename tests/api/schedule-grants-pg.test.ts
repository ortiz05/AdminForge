import { PgSessionStore } from '@adminforge/api/src/auth/session-store';
import { PgSealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { grantPartition, PgScheduleGrantStore } from '@adminforge/api/src/schedules/grants';
import { PgScheduleStore } from '@adminforge/api/src/schedules/pg-store';
import { schedule } from '../support/scheduler';
import { testDatabaseUrl } from './db';

// Creators' grants on Postgres (ADR-014, migration 0012): one row per schedule, removed with the schedule; the sealed
// tokens under `schedule:<id>` are not a session's, so the session purge keeps them while the grant exists and drops
// them once it doesn't.

const url = await testDatabaseUrl();
const NOW = new Date('2026-10-15T12:00:00.000Z');

describe.skipIf(!url)('schedule grants on Postgres', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    await db.pool.query('truncate schedules, schedule_runs, schedule_grants, token_cache cascade');
  });
  afterAll(async () => {
    await db.pool.query('truncate schedules, schedule_runs, schedule_grants, token_cache cascade');
    await db.close();
  });

  async function scheduleRow(key: string) {
    const store = new PgScheduleStore(db.db);
    return (await store.insertSchedule({
      key,
      source: 'portal',
      definition: schedule(key),
      sha256: `sha-${key}`,
      enabled: true,
      nextRunAt: null,
      createdBy: 'u-1',
    }))!;
  }

  it('stores, updates and deletes a grant; deleting the schedule deletes it too', async () => {
    const grants = new PgScheduleGrantStore(db.db);
    const row = await scheduleRow('portal.a');
    await grants.put({
      scheduleId: row.id,
      userOid: 'u-1',
      upn: 'avery@example.com',
      homeAccountId: 'h-1',
      status: 'active',
      reason: null,
      consentedAt: NOW,
      checkedAt: null,
    });
    await grants.setStatus(row.id, 'needs_sign_in', 'reauth', NOW);
    expect(await grants.get(row.id)).toMatchObject({ status: 'needs_sign_in', reason: 'reauth' });
    await expect(
      db.pool.query("update schedule_grants set status = 'whatever' where schedule_id = $1", [row.id]),
    ).rejects.toThrow(/schedule_grants_status_check/);
    await db.pool.query('delete from schedules where id = $1', [row.id]);
    expect(await grants.get(row.id)).toBeNull();
  });

  it('the session purge keeps a grant’s tokens while the grant exists, and drops them once it is gone', async () => {
    const grants = new PgScheduleGrantStore(db.db);
    const blobs = new PgSealedBlobStore(db.db);
    const kept = await scheduleRow('portal.kept');
    const gone = await scheduleRow('portal.gone');
    await grants.put({
      scheduleId: kept.id,
      userOid: 'u-1',
      upn: 'avery@example.com',
      homeAccountId: 'h-1',
      status: 'active',
      reason: null,
      consentedAt: NOW,
      checkedAt: null,
    });
    await blobs.set(grantPartition(kept.id), 'sealed');
    await blobs.set(grantPartition(gone.id), 'sealed');
    // Older than the orphan rule's day: a session partition this old without a session would go.
    await db.pool.query("update token_cache set updated_at = $1::timestamptz - interval '30 days'", [
      NOW.toISOString(),
    ]);
    await new PgSessionStore(db.db).purge({ now: NOW, idleMinutes: 60 });
    const { rows } = await db.pool.query<{ partition_key: string }>('select partition_key from token_cache');
    expect(rows.map((r) => r.partition_key)).toEqual([grantPartition(kept.id)]);
  });
});
