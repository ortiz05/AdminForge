import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import BetterSqlite3 from 'better-sqlite3';
import { SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { dbBackup } from '@adminforge/cli/src/commands/db';
import { testDatabasePath } from './db';

// `adminforge db backup` copies the whole history — the audit log, runs with their inputs and outputs, approvals,
// schedules. A copy of the history is itself part of it (S-41): before the copy leaves the process, the command appends
// a `database.backup` event to the live database through the normal audit writer — who, where to (stdout or a file,
// never the path), plaintext or not, size and the copy's audit tail. If that event can't be written, the copy doesn't
// leave — a file copy takes the operator's name only once it is recorded. A record, not a control: copying the volume
// needs no CLI.
interface AuditRow {
  seq: number;
  actor_oid: string | null;
  actor_upn: string | null;
  mode: string | null;
  action: string;
  target_type: string | null;
  result: string;
  details: string | null;
}

describe('adminforge db backup is in the audit log (SQLite)', () => {
  let file: string;
  let database: Database;
  const quiet = { out: () => undefined, err: () => undefined };
  const scratch = () => mkdtempSync(path.join(tmpdir(), 'af-backup-audit-'));
  const backups = () =>
    database.sqlite
      .prepare("select * from audit_events where action = 'database.backup' order by seq")
      .all() as AuditRow[];
  const count = (sqlite: BetterSqlite3.Database) =>
    (sqlite.prepare('select count(*) as n from audit_events').get() as { n: number }).n;

  beforeEach(async () => {
    file = await testDatabasePath();
    database = createDatabase(file);
    const audit = new SqliteAuditWriter(database.db, undefined, null);
    for (let i = 0; i < 3; i++)
      await audit.append({ action: 'test.event', result: 'success', correlationId: `c-${i}` });
  });
  afterEach(async () => {
    await database.close();
  });

  it('a file copy: one event with who, the destination kind, size and the tail — never the path', async () => {
    const dir = scratch();
    const dest = path.join(dir, 'private-name-adminforge.db');
    const lines: string[] = [];
    await dbBackup(
      { DATABASE_PATH: file },
      dest,
      { out: (l) => lines.push(l), err: () => undefined },
      {
        plaintext: true,
      },
    );

    const [event, ...more] = backups();
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor_oid: 'cli',
      mode: 'read',
      action: 'database.backup',
      target_type: 'database',
      result: 'success',
    });
    expect(event!.actor_upn).toMatch(new RegExp(`@${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    const details = JSON.parse(event!.details!);
    expect(details).toMatchObject({ destination: 'file', plaintext: true, auditEvents: 3, tailSeq: 3 });
    expect(details.bytes).toBeGreaterThan(0);
    expect(event!.details).not.toContain(dir);
    expect(event!.details).not.toContain('private-name');
    expect(lines.join('\n')).toMatch(/recorded in the audit log/);
    // It took its name only once recorded (written under a hidden name first): nothing else is left in the folder.
    expect(readdirSync(dir)).toEqual(['private-name-adminforge.db']);

    // The copy is the history as it was; the live history now also says a copy was made, and still verifies.
    const copy = new BetterSqlite3(dest, { readonly: true });
    try {
      expect(count(copy)).toBe(3);
    } finally {
      copy.close();
    }
    expect(count(database.sqlite)).toBe(4);
    expect((await new SqliteAuditWriter(database.db, undefined, null).verify()).ok).toBe(true);
  });

  it('stdout: the event is in the history before the first byte of the copy leaves', async () => {
    const seenAtFirstByte: number[] = [];
    let bytes = 0;
    const stdout = new Writable({
      write(chunk: Buffer, _enc, done) {
        if (!bytes) seenAtFirstByte.push(backups().length);
        bytes += chunk.length;
        done();
      },
    });
    await dbBackup({ DATABASE_PATH: file }, '-', { ...quiet, stdout });
    expect(seenAtFirstByte).toEqual([1]);
    const details = JSON.parse(backups()[0]!.details!);
    expect(details).toMatchObject({ destination: 'stdout', plaintext: false, bytes, tailSeq: 3 });
  });

  it('no event, no copy: when the audit log refuses the event, nothing leaves', async () => {
    database.sqlite.exec(
      `create trigger refuse_backup_event before insert on audit_events when new.action = 'database.backup'
       begin select raise(abort, 'audit log unavailable'); end;`,
    );
    const dir = scratch();
    await expect(
      dbBackup({ DATABASE_PATH: file }, path.join(dir, 'b.db'), quiet, { plaintext: true }),
    ).rejects.toThrow(/audit log unavailable/);
    expect(readdirSync(dir)).toEqual([]);

    let written = 0;
    const stdout = new Writable({
      write(chunk: Buffer, _enc, done) {
        written += chunk.length;
        done();
      },
    });
    await expect(dbBackup({ DATABASE_PATH: file }, '-', { ...quiet, stdout })).rejects.toThrow(
      /audit log unavailable/,
    );
    expect(written).toBe(0);
  });

  it('a copy that fails its checks is recorded as a failure (and nothing is written)', async () => {
    database.sqlite
      .prepare(
        `insert into audit_events (ts, action, result, correlation_id, prev_hash, hash)
         values (1, 'forged', 'success', 'c', 'not-the-chain', 'whatever')`,
      )
      .run();
    const dest = path.join(scratch(), 'c.db');
    await expect(dbBackup({ DATABASE_PATH: file }, dest, quiet, { plaintext: true })).rejects.toThrow(
      /audit chain is broken/,
    );
    expect(existsSync(dest)).toBe(false);
    const [event] = backups();
    expect(event).toMatchObject({ action: 'database.backup', result: 'failure' });
    expect(JSON.parse(event!.details!)).toEqual({ destination: 'file', plaintext: true });
  });

  it('refuses an existing destination before copying anything, and leaves it alone', async () => {
    const dir = scratch();
    const dest = path.join(dir, 'taken.db');
    writeFileSync(dest, 'not a backup');
    await expect(dbBackup({ DATABASE_PATH: file }, dest, quiet, { plaintext: true })).rejects.toThrow(
      /already exists; choose a new file name/,
    );
    expect(readFileSync(dest, 'utf8')).toBe('not a backup');
    expect(readdirSync(dir)).toEqual(['taken.db']);
    expect(backups()).toEqual([]);
  });

  it('records nothing for a refused request (no --plaintext, no database)', async () => {
    await expect(dbBackup({ DATABASE_PATH: file }, path.join(scratch(), 'd.db'), quiet)).rejects.toThrow(
      /not encrypted/,
    );
    await expect(dbBackup({ DATABASE_PATH: `${file}.missing` }, '-', quiet)).rejects.toThrow(/no database/);
    expect(backups()).toEqual([]);
  });
});
