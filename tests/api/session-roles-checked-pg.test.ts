import { randomBytes } from 'node:crypto';
import { PgSessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { testDatabaseUrl } from './db';

// IAM-03: when a session's roles were last confirmed is stored (migration 0007), so the API and the run worker — often
// separate processes — share one 5-minute re-check instead of each keeping its own in memory.
const url = await testDatabaseUrl();

const session = (idHash: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  idHash,
  userOid: 'u-roles-checked',
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

describe.skipIf(!url)('sessions.roles_checked_at (Postgres)', () => {
  let database: Database;
  const ids: string[] = [];
  const id = () => {
    const h = `roles-checked-${randomBytes(8).toString('hex')}`;
    ids.push(h);
    return h;
  };
  beforeAll(() => {
    database = createDatabase(url!);
  });
  afterAll(async () => {
    const store = new PgSessionStore(database.db);
    for (const h of ids) await store.delete(h);
    await database?.close();
  });

  it('is stored on create and update, and null for rows that never had it', async () => {
    const store = new PgSessionStore(database.db);
    const at = new Date('2026-10-15T12:00:00.000Z');
    const a = id();
    await store.create(session(a, { rolesCheckedAt: at }));
    expect((await store.get(a))!.rolesCheckedAt).toEqual(at);
    const later = new Date('2026-10-15T12:06:00.000Z');
    expect((await store.update(a, { rolesCheckedAt: later }))!.rolesCheckedAt).toEqual(later);

    const b = id();
    await store.create(session(b));
    expect((await store.get(b))!.rolesCheckedAt).toBeNull();
  });
});
