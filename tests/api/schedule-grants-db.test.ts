import { SqliteSessionStore } from '@adminforge/api/src/auth/session-store';
import { SqliteSealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { grantPartition, SqliteScheduleGrantStore } from '@adminforge/api/src/schedules/grants';
import { SqliteScheduleStore } from '@adminforge/api/src/schedules/sqlite-store';
import { schedule } from '../support/scheduler';
import { testDatabasePath } from './db';

// Creators' grants in the database (ADR-014): one row per schedule, removed with the schedule; the sealed tokens under
// `schedule:<id>` are not a session's, so the session purge keeps them while the grant exists and drops them once it
// doesn't.

const file = await testDatabasePath();
const NOW = new Date('2026-10-15T12:00:00.000Z');
// Grants go with their schedule (ON DELETE CASCADE); schedule runs point at schedules, so they go first.
const RESET =
  'delete from schedule_grants; delete from schedule_runs; delete from schedules; delete from token_cache;';

describe('schedule grants on SQLite', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(file);
  });
  beforeEach(() => {
    db.sqlite.exec(RESET);
  });
  afterAll(async () => {
    db.sqlite.exec(RESET);
    await db.close();
  });

  async function scheduleRow(key: string) {
    const store = new SqliteScheduleStore(db.db);
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
    const grants = new SqliteScheduleGrantStore(db.db);
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
    expect(() =>
      db.sqlite.prepare("update schedule_grants set status = 'whatever' where schedule_id = ?").run(row.id),
    ).toThrow(/schedule_grants_status_check/);
    db.sqlite.prepare('delete from schedules where id = ?').run(row.id);
    expect(await grants.get(row.id)).toBeNull();
  });

  it('the session purge keeps a grant’s tokens while the grant exists, and drops them once it is gone', async () => {
    const grants = new SqliteScheduleGrantStore(db.db);
    const blobs = new SqliteSealedBlobStore(db.db);
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
    db.sqlite.prepare('update token_cache set updated_at = ?').run(NOW.getTime() - 30 * 86_400_000);
    await new SqliteSessionStore(db.db).purge({ now: NOW, idleMinutes: 60 });
    const rows = db.sqlite.prepare('select partition_key from token_cache').all() as Array<{
      partition_key: string;
    }>;
    expect(rows.map((r) => r.partition_key)).toEqual([grantPartition(kept.id)]);
  });
});
