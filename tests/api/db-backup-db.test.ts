import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { BACKUP_EMPTIED_TABLES, backupDatabase } from '@adminforge/api/src/db/backup';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { testDatabasePath } from './db';

// `adminforge db backup` (db/backup.ts): a consistent copy of the live database without credential rows — signed-in
// sessions, sign-in round trips, sealed refresh tokens — and without process state (leases, signals), rebuilt so
// nothing deleted lingers in free pages, checked before it is put in place, private (0600).
describe('database backup (SQLite)', () => {
  let database: Database;
  const out = () => mkdtempSync(path.join(tmpdir(), 'af-backup-'));
  const SECRET = 'sealed-refresh-token-that-must-not-leave';

  beforeAll(async () => {
    database = createDatabase(await testDatabasePath());
    const s = database.sqlite;
    s.prepare(
      `insert into sessions (id_hash, user_oid, upn, display_name, tenant_id, tenant_name, tenant_domain, csrf,
         created_at, last_seen_at, expires_at) values ('sid', 'u-1', 'a@example.com', 'A', 't', 'Example Org', 'example.com', 'c', 1, 1, 1)`,
    ).run();
    s.prepare(`insert into token_cache (partition_key, sealed, updated_at) values ('read:sid', ?, 1)`).run(
      SECRET,
    );
    s.prepare(`insert into token_cache (partition_key, sealed, updated_at) values ('schedule:x', ?, 1)`).run(
      SECRET,
    );
    s.prepare(
      `insert into preauth (state, kind, verifier, nonce, return_to, created_at, expires_at)
       values ('st', 'read', ?, 'n', '/', 1, 2)`,
    ).run(SECRET);
    s.prepare(
      `insert into leases (name, holder, expires_at) values ('adminforge.scheduler', 'api:1', 9e15)`,
    ).run();
    database.signals.publish('definitions_changed', '{"all":true}');
    s.prepare(
      `insert into settings (key, value, updated_at) values ('appearance', '{"accent":"steel"}', 1)`,
    ).run();
    const audit = new SqliteAuditWriter(database.db, undefined, null);
    for (let i = 0; i < 5; i++)
      await audit.append({
        action: 'test.event',
        result: 'success',
        correlationId: `c-${i}`,
        details: { i },
      });
  });
  afterAll(async () => {
    await database.close();
  });

  it('writes a private, self-contained copy without credentials or process state, with history intact', async () => {
    const dest = path.join(out(), 'nested', 'adminforge-backup.db');
    const result = await backupDatabase(database, dest);
    expect(result).toMatchObject({ file: dest, audit: { count: 5, tail: { seq: 5 } } });
    expect(result.bytes).toBe(statSync(dest).size);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    // One file: no -wal/-shm/-journal next to it, and no leftover partial copies.
    expect(readdirSync(path.dirname(dest))).toEqual(['adminforge-backup.db']);
    const copy = new BetterSqlite3(dest, { readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      for (const table of BACKUP_EMPTIED_TABLES)
        expect(copy.prepare(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
      expect(copy.prepare('select key from settings').all()).toEqual([{ key: 'appearance' }]);
      expect(copy.prepare('select count(*) as n from audit_events').get()).toEqual({ n: 5 });
    } finally {
      copy.close();
    }
    // VACUUM rebuilt the file: the deleted token's bytes are nowhere in it.
    expect(readFileSync(dest).includes(Buffer.from(SECRET))).toBe(false);
    // The live database still has everything.
    expect(database.sqlite.prepare('select count(*) as n from token_cache').get()).toEqual({ n: 2 });
  });

  it('never overwrites a file', async () => {
    const dest = path.join(out(), 'b.db');
    await backupDatabase(database, dest);
    await expect(backupDatabase(database, dest)).rejects.toThrow(/already exists; choose a new file name/);
  });

  it('leaves nothing behind when the copy fails its checks (a broken audit chain)', async () => {
    const broken = createDatabase(await testDatabasePath());
    try {
      broken.sqlite
        .prepare(
          `insert into audit_events (ts, action, result, correlation_id, prev_hash, hash)
           values (1, 'forged', 'success', 'c', 'not-the-genesis', 'whatever')`,
        )
        .run();
      const dir = out();
      await expect(backupDatabase(broken, path.join(dir, 'c.db'))).rejects.toThrow(
        /audit chain is broken at event #0/,
      );
      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(path.join(dir, 'c.db'))).toBe(false);
    } finally {
      await broken.close();
    }
  });
});
