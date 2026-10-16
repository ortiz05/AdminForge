import { randomBytes } from 'node:crypto';
import { PgAuditWriter } from '@adminforge/api/src/audit/writer';
import { PgPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { PgSessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, PgSealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { PgPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import { buildApp } from '@adminforge/api/src/app';
import { resetTables, testDatabaseUrl } from './db';
import { cookieFrom, getMe, mockConfig } from './helpers';

const url = await testDatabaseUrl();
const DAY = 86_400_000;

const session = (idHash: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  idHash,
  userOid: 'u-1',
  upn: 'avery@example.com',
  displayName: 'Avery Engineer',
  tenantId: 't-1',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader'],
  csrf: 'csrf-token',
  readAccountId: 'acct',
  writeAccountId: null,
  writeExpiresAt: null,
  writeExtended: false,
  writeReason: null,
  createdAt: new Date('2026-10-15T12:00:00.000Z'),
  lastSeenAt: new Date('2026-10-15T12:00:00.000Z'),
  expiresAt: new Date('2026-10-16T00:00:00.000Z'),
  ip: '127.0.0.1',
  userAgent: 'vitest',
  ...overrides,
});

describe.skipIf(!url)('Postgres-backed stores', () => {
  let database: Database;
  beforeAll(() => {
    database = createDatabase(url!);
  });
  beforeEach(async () => {
    await resetTables(database);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('PgSessionStore: create, get, update, delete', async () => {
    const store = new PgSessionStore(database.db);
    await store.create(session('h1', { roles: ['Portal.Reader', 'Portal.Operator'] }));
    expect(await store.get('h1')).toMatchObject({
      idHash: 'h1',
      roles: ['Portal.Reader', 'Portal.Operator'],
      writeExtended: false,
    });
    const until = new Date('2026-10-15T13:00:00.000Z');
    expect(await store.update('h1', { writeAccountId: 'w', writeExpiresAt: until })).toMatchObject({
      writeAccountId: 'w',
      writeExpiresAt: until,
    });
    expect(await store.update('missing', { roles: [] })).toBeNull();
    await store.delete('h1');
    expect(await store.get('h1')).toBeNull();
  });

  it('PgSessionStore.purge drops tokens of unusable sessions now and rows after retention', async () => {
    const store = new PgSessionStore(database.db);
    const blobs = new PgSealedBlobStore(database.db);
    const now = new Date('2026-10-15T12:00:00.000Z');
    await store.create(session('live', { lastSeenAt: now, expiresAt: new Date(now.getTime() + DAY) }));
    await store.create(
      session('idle', {
        lastSeenAt: new Date(now.getTime() - 2 * 3_600_000),
        expiresAt: new Date(now.getTime() + DAY),
      }),
    );
    await store.create(
      session('old', {
        lastSeenAt: new Date(now.getTime() - 9 * DAY),
        expiresAt: new Date(now.getTime() - 8 * DAY),
      }),
    );
    await store.create(
      session('disarmed', {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + DAY),
        writeAccountId: 'w',
        writeExpiresAt: new Date(now.getTime() - 60_000),
      }),
    );
    for (const id of ['live', 'idle', 'old', 'disarmed']) {
      await blobs.set(`read:${id}`, 'sealed');
      await blobs.set(`write:${id}`, 'sealed');
    }
    await blobs.set('read:orphan', 'sealed');
    // Relative to the test's fixed clock, not the database's: purge compares with `now`.
    await database.pool.query(
      "update token_cache set updated_at = $1::timestamptz - interval '2 days' where partition_key = 'read:orphan'",
      [now.toISOString()],
    );

    expect(await store.purge({ now, idleMinutes: 60 })).toBe(1);
    expect(await store.get('old')).toBeNull();
    expect(await store.get('idle')).not.toBeNull();
    const { rows } = await database.pool.query<{ partition_key: string }>(
      'select partition_key from token_cache order by 1',
    );
    expect(rows.map((r) => r.partition_key)).toEqual(['read:disarmed', 'read:live', 'write:live']);
  });

  it('token cache: sealed at rest, round-trips, bound to its partition, deletable', async () => {
    const key = randomBytes(32);
    const blobs = new PgSealedBlobStore(database.db);
    const cache = createTokenCache(blobs, key);
    const plaintext = JSON.stringify({ RefreshToken: { x: { secret: 'refresh-token-plaintext' } } });
    await cache.set('read:abc', plaintext);
    await cache.set('read:abc', plaintext); // upsert
    expect(await cache.get('read:abc')).toBe(plaintext);
    const { rows } = await database.pool.query<{ sealed: string }>(
      "select sealed from token_cache where partition_key = 'read:abc'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sealed).not.toContain('refresh-token-plaintext');
    expect(rows[0]!.sealed.startsWith('1.')).toBe(true);

    // A blob copied to another session's partition does not open (AAD = partition key).
    await blobs.set('read:other', rows[0]!.sealed);
    expect(await cache.get('read:other')).toBe('');
    // A different key does not open it either.
    expect(await createTokenCache(blobs, randomBytes(32)).get('read:abc')).toBe('');

    await cache.delete('read:abc');
    expect(await cache.get('read:abc')).toBe('');
  });

  it('PgPreauthStore.take is single use', async () => {
    const store = new PgPreauthStore(database.db);
    const expiresAt = new Date(Date.now() + 600_000);
    await store.put({
      state: 's1',
      kind: 'write',
      verifier: 'v',
      nonce: 'n',
      returnTo: '/',
      sessionIdHash: 'h',
      bindingHash: 'b',
      details: { minutes: 30, reason: 'Testing arm' },
      expiresAt,
    });
    expect(await store.take('s1')).toEqual({
      state: 's1',
      kind: 'write',
      verifier: 'v',
      nonce: 'n',
      returnTo: '/',
      sessionIdHash: 'h',
      bindingHash: 'b',
      details: { minutes: 30, reason: 'Testing arm' },
      expiresAt,
    });
    expect(await store.take('s1')).toBeNull();
    await store.put({
      state: 's2',
      kind: 'read',
      verifier: 'v',
      nonce: 'n',
      returnTo: '/',
      sessionIdHash: null,
      bindingHash: null,
      details: null,
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await store.purge(new Date())).toBe(1);
  });

  it('PgPrefsStore round-trips and upserts', async () => {
    const store = new PgPrefsStore(database.db);
    expect(await store.get('u-1')).toEqual({});
    await store.put('u-1', { theme: 'steel' });
    await store.put('u-1', { theme: 'daylight', pinned: ['identity.users'] });
    expect(await store.get('u-1')).toEqual({ theme: 'daylight', pinned: ['identity.users'] });
  });

  it('PgAuditWriter: concurrent appends form one verifiable chain; rows are append-only', async () => {
    const writer = new PgAuditWriter(database.db);
    const before = await database.pool.query<{ n: string }>('select count(*) as n from audit_events');
    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writer.append({
          action: 'test.event',
          result: 'success',
          correlationId: `c-${i}`,
          details: { i, nested: { b: 2, a: 1 } },
          actorUpn: i % 2 ? 'avery@example.com' : undefined,
        }),
      ),
    );
    const seqs = appended.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs.at(-1)! - seqs[0]!).toBe(11);
    const { rows } = await database.pool.query<{ seq: string; prev_hash: string; hash: string }>(
      'select seq, prev_hash, hash from audit_events order by seq desc limit 12',
    );
    const ordered = rows.reverse();
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.prev_hash).toBe(ordered[i - 1]!.hash);
    expect(await writer.verify()).toEqual({ ok: true, count: Number(before.rows[0]!.n) + 12 });

    await expect(
      database.pool.query("update audit_events set result = 'tampered' where seq = $1", [seqs[0]]),
    ).rejects.toThrow(/append-only/);
    await expect(database.pool.query('delete from audit_events where seq = $1', [seqs[0]])).rejects.toThrow(
      /append-only/,
    );
  });

  it('the app runs on Postgres stores (mock sign-in → /api/me → audit row)', async () => {
    const app = await buildApp(mockConfig({ DATABASE_URL: url! }));
    try {
      // No run worker or scheduler in this test: the API is ready, but reports them (heartbeats) as degraded.
      expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toMatchObject({
        status: 'degraded',
        checks: {
          db: 'ok',
          worker: expect.stringMatching(/missing|stale/),
          scheduler: expect.stringMatching(/missing|stale/),
        },
      });
      const login = await app.inject({ method: 'GET', url: '/auth/login' });
      const cookie = cookieFrom(login)!;
      const { me } = await getMe(app, cookie);
      expect(me!.user.name).toBe('Avery Engineer');
      const put = await app.inject({
        method: 'PUT',
        url: '/api/me/prefs',
        headers: { cookie, 'x-adminforge-csrf': me!.csrf },
        payload: { density: 'compact' },
      });
      expect(put.statusCode).toBe(200);
      expect((await getMe(app, cookie)).me!.prefs).toEqual({ density: 'compact' });
      const { rows } = await database.pool.query<{ action: string }>(
        "select action from audit_events where action in ('session.signin', 'prefs.updated') order by seq desc limit 2",
      );
      expect(rows.map((r) => r.action)).toEqual(['prefs.updated', 'session.signin']);
    } finally {
      await app.close();
    }
  });
});
