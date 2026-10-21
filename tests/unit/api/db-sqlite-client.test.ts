import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@adminforge/api/src/config';
import { createDatabase, databaseOptions, writeTx } from '@adminforge/api/src/db/client';
import { migrateDatabase } from '@adminforge/api/src/db/migrate';
import {
  DB_APPROVAL_STATUSES,
  DB_PROBE_STATUSES,
  DB_RUN_STATUSES,
  DB_SCHEDULE_RUN_STATUSES,
  DB_STEP_STATUSES,
  settings,
} from '@adminforge/api/src/db/schema';
import { SCHEDULE_RUN_STATUSES } from '@adminforge/api/src/schedules/types';
import { RUN_STATUSES, STEP_STATUSES } from '@adminforge/engine';

// The SQLite client (ADR-016): the file is private from the moment it exists, every connection gets the same
// settings, write transactions are synchronous and take the write lock up front, and the status CHECK constraints
// follow the code's own lists.
const scratch = () => mkdtempSync(path.join(tmpdir(), 'af-sqlite-'));
const mode = (f: string) => statSync(f).mode & 0o777;
const base = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'mock',
  DATA_MODE: 'fixtures',
};

describe('opening the database file', () => {
  it('creates the folder 0700 and the file 0600 before SQLite writes anything, and WAL siblings the same', async () => {
    const dir = path.join(scratch(), 'nested', 'state');
    const file = path.join(dir, 'adminforge.db');
    const database = createDatabase(file);
    try {
      migrateDatabase(database);
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      expect(mode(`${file}-wal`)).toBe(0o600);
    } finally {
      await database.close();
    }
  });

  it('tightens an existing file that others could read (a volume mounted with fsGroup adds group bits)', async () => {
    const file = path.join(scratch(), 'adminforge.db');
    writeFileSync(file, '');
    chmodSync(file, 0o664);
    const database = createDatabase(file);
    await database.close();
    expect(mode(file)).toBe(0o600);
  });

  it('applies the same settings on every connection', async () => {
    const database = createDatabase(path.join(scratch(), 'a.db'), { busyTimeoutMs: 1234 });
    try {
      const p = (name: string) => database.sqlite.pragma(name, { simple: true });
      expect(p('journal_mode')).toBe('wal');
      expect(p('foreign_keys')).toBe(1);
      expect(p('synchronous')).toBe(2); // FULL: a committed audit event survives a power cut
      expect(p('secure_delete')).toBe(1);
      expect(p('trusted_schema')).toBe(0);
      expect(p('auto_vacuum')).toBe(2); // INCREMENTAL on a new file: retention's free pages go back (reclaimSpace)
      expect(p('busy_timeout')).toBe(1234);
      await expect(database.ping()).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it('takes the busy timeout from the configuration (default 15 s)', () => {
    expect(databaseOptions(loadConfig(base), 'api')).toEqual({ name: 'api', busyTimeoutMs: 15_000 });
    expect(databaseOptions(loadConfig({ ...base, DATABASE_BUSY_TIMEOUT_MS: '500' }))).toEqual({
      busyTimeoutMs: 500,
    });
    expect(() => loadConfig({ ...base, DATABASE_BUSY_TIMEOUT_MS: '0' })).toThrow(/DATABASE_BUSY_TIMEOUT_MS/);
  });

  it('opens read-only without creating anything (audit verify)', () => {
    const file = path.join(scratch(), 'missing.db');
    expect(() => createDatabase(file, { readonly: true })).toThrow();
  });
});

describe('write transactions', () => {
  it('are synchronous and immediate; a promise-returning function is refused', async () => {
    const database = createDatabase(path.join(scratch(), 'tx.db'));
    try {
      migrateDatabase(database);
      const row = writeTx(database.db, (tx) =>
        tx
          .insert(settings)
          .values({ key: 'k', value: { a: 1 } })
          .returning()
          .get(),
      );
      expect(row).toMatchObject({ key: 'k', value: { a: 1 }, version: 1 });
      // A transaction that throws leaves nothing behind.
      expect(() =>
        writeTx(database.db, (tx) => {
          tx.insert(settings).values({ key: 'k2', value: 1 }).run();
          throw new Error('stop');
        }),
      ).toThrow('stop');
      expect(database.sqlite.prepare("select count(*) as n from settings where key = 'k2'").get()).toEqual({
        n: 0,
      });
      // @ts-expect-error — an async function would commit before its awaits ran: writeTx's type refuses it…
      expect(() => writeTx(database.db, async () => 1)).toThrow(/promise/i); // …and better-sqlite3 at run time.
    } finally {
      await database.close();
    }
  });
});

describe('status CHECK constraints follow the code', () => {
  it('lists the same values as the engine, the scheduler and the approvals', () => {
    expect([...DB_RUN_STATUSES]).toEqual([...RUN_STATUSES]);
    expect([...DB_STEP_STATUSES]).toEqual([...STEP_STATUSES]);
    expect([...DB_SCHEDULE_RUN_STATUSES]).toEqual([...SCHEDULE_RUN_STATUSES]);
    expect([...DB_APPROVAL_STATUSES].sort()).toEqual([
      'approved',
      'cancelled',
      'expired',
      'pending',
      'rejected',
    ]);
    expect([...DB_PROBE_STATUSES]).toEqual(['ok', 'warn', 'crit', 'error']);
  });

  it('the migrated database refuses a status the code does not know', async () => {
    const database = createDatabase(path.join(scratch(), 'check.db'));
    try {
      migrateDatabase(database);
      const insert = (status: string) =>
        database.sqlite
          .prepare(
            `insert into runs (id, kind, definition_key, definition_version, definition_sha256, status, correlation_id,
               created_at, updated_at) values (?, 'playbook', 'k', '1.0.0', 's', ?, 'c', 1, 1)`,
          )
          .run(`r-${status}`, status);
      expect(() => insert('succeeded')).not.toThrow();
      expect(() => insert('finished')).toThrow(/CHECK constraint failed/);
    } finally {
      await database.close();
    }
  });
});
