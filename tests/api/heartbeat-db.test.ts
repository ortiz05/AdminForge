import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { componentStates, Heartbeat, STALE_MS } from '@adminforge/api/src/health/heartbeat';
import { testDatabasePath } from './db';

// /readyz reports the run worker and scheduler from their heartbeats: a stopped component shows as stale/missing.
const file = await testDatabasePath();

describe('heartbeats (SQLite)', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(file);
  });
  beforeEach(() => {
    database.sqlite.prepare("delete from settings where key like 'heartbeat:%'").run();
  });
  afterAll(async () => {
    await database?.close();
  });

  it('missing until a component beats, ok while it does, stale after it stops', async () => {
    let now = new Date('2026-10-15T12:00:00Z');
    expect(await componentStates(database.db, now)).toEqual({ worker: 'missing', scheduler: 'missing' });
    await new Heartbeat(database.db, 'worker', () => now).beat();
    await new Heartbeat(database.db, 'scheduler', () => now).beat();
    expect(await componentStates(database.db, now)).toEqual({ worker: 'ok', scheduler: 'ok' });
    now = new Date(now.getTime() + STALE_MS + 1000);
    await new Heartbeat(database.db, 'scheduler', () => now).beat();
    expect(await componentStates(database.db, now)).toEqual({ worker: 'stale', scheduler: 'ok' });
  });
});
