import {
  PREAUTH_EVICT_AFTER_MS,
  PREAUTH_TTL_MS,
  SqlitePreauthStore,
  type PreauthRecord,
} from '@adminforge/api/src/auth/preauth-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { resetTables, testDatabasePath } from './db';

// S-28 on SQLite: the cap on pending sign-ins is checked in the same write transaction as the insert: the oldest
// pending sign-in that has had two minutes makes room, a start that finds none writes nothing, expired rows don't
// count (before or after the purge), and arm round trips are never refused or evicted.
const file = await testDatabasePath();

describe('SqlitePreauthStore: global cap on pending sign-ins', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(file);
  });
  afterAll(() => database.close());
  beforeEach(() => resetTables(database));

  const T0 = Date.parse('2026-10-21T08:00:00Z');
  const record = (state: string, startedAt: number, sessionIdHash: string | null = null): PreauthRecord => ({
    state,
    kind: sessionIdHash ? 'write' : 'read',
    verifier: 'v',
    nonce: 'n',
    returnTo: '/',
    sessionIdHash,
    bindingHash: 'b',
    details: null,
    expiresAt: new Date(startedAt + PREAUTH_TTL_MS),
  });
  const count = () => (database.sqlite.prepare('select count(*) as n from preauth').get() as { n: number }).n;

  it('refuses the sign-in start beyond the cap without writing; arming still starts', async () => {
    const store = new SqlitePreauthStore(database.db, { maxPending: 2 });
    await store.put(record('a', T0));
    await store.put(record('b', T0 + 1000));
    await expect(store.put(record('c', T0 + 2000))).rejects.toMatchObject({
      status: 503,
      code: 'signin_busy',
    });
    expect(count()).toBe(2);
    expect(await store.take('c')).toBeNull();
    await store.put(record('arm', T0 + 3000, 'session-hash'));
    expect(count()).toBe(3);
  });

  it('evicts the oldest sign-in old enough to make room, never an arm round trip', async () => {
    const store = new SqlitePreauthStore(database.db, { maxPending: 3 });
    await store.put(record('arm', T0, 'session-hash'));
    await store.put(record('old', T0 + 1000));
    await store.put(record('newer', T0 + 60_000));
    const later = T0 + 1000 + PREAUTH_EVICT_AFTER_MS;
    await store.put(record('new', later));
    expect(count()).toBe(3);
    expect(await store.take('old')).toBeNull();
    for (const state of ['arm', 'newer', 'new']) expect((await store.take(state))?.state).toBe(state);
  });

  it('refuses when the oldest pending sign-in is younger than two minutes', async () => {
    const store = new SqlitePreauthStore(database.db, { maxPending: 2 });
    await store.put(record('a', T0));
    await store.put(record('b', T0));
    await expect(store.put(record('c', T0 + PREAUTH_EVICT_AFTER_MS - 1))).rejects.toMatchObject({
      code: 'signin_busy',
    });
    await store.put(record('d', T0 + PREAUTH_EVICT_AFTER_MS));
    expect(count()).toBe(2);
    expect(await store.take('a')).toBeNull();
  });

  it('counts only rows still pending when the new one starts', async () => {
    const store = new SqlitePreauthStore(database.db, { maxPending: 2 });
    await store.put(record('a', T0));
    await store.put(record('b', T0));
    // Ten minutes later both have expired (the purge hasn't run): a new sign-in starts.
    await store.put(record('c', T0 + PREAUTH_TTL_MS + 1));
    expect(count()).toBe(3);
    expect(await store.purge(new Date(T0 + PREAUTH_TTL_MS + 1))).toBe(2);
    expect((await store.take('c'))?.state).toBe('c');
  });

  it('a single use record still round-trips intact under the cap', async () => {
    const store = new SqlitePreauthStore(database.db);
    const r = { ...record('s1', T0), details: { minutes: 30, reason: 'Testing arm' } };
    await store.put(r);
    expect(await store.take('s1')).toEqual(r);
    expect(await store.take('s1')).toBeNull();
  });
});
