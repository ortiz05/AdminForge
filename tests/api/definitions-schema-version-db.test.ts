import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { migrateDatabase } from '@adminforge/api/src/db/migrate';
import { DbDefinitionStore, type PublishEntry } from '@adminforge/api/src/definitions';
import { migrationsDir } from '@adminforge/api/src/paths';
import { CONTENT_SCHEMA_VERSION, validateDefinition } from '@adminforge/schemas';
import { testDatabasePath } from './db';

// Each definition row records the content schema version it was published under (D-07): publish stamps it, a plain
// ADD COLUMN brought it in (rows from before are version 1), `publish --dry-run` lists rows under an older version and
// whether they still pass the current schemas, and publishing the same content again stamps the current version.
const file = await testDatabasePath();
const ns = `t${Date.now().toString(36)}`;

function entry(name: string, version = '1.0.0', extra: Record<string, unknown> = {}): PublishEntry {
  const raw = {
    kind: 'page',
    id: `${ns}.${name}`,
    version,
    title: `Page ${name}`,
    owner: 'test-team',
    template: 'list-detail',
    datasources: { rows: { source: 'static', data: [1] } },
    layout: [{ widget: 'kpi', data: 'rows' }],
    ...extra,
  };
  const r = validateDefinition(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { def: r.def, sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}

const scratch = () => mkdtempSync(path.join(tmpdir(), 'af-schema-version-'));

describe('the content schema version of published rows (SQLite)', () => {
  let database: Database;
  const versionOf = (name: string, version = '1.0.0') =>
    (
      database.sqlite
        .prepare('select schema_version as v from definitions where key = ? and version = ?')
        .get(`${ns}.${name}`, version) as { v: number }
    ).v;

  beforeAll(() => {
    database = createDatabase(file, { name: 'cli' });
  });
  afterAll(async () => {
    database.sqlite.prepare('delete from definitions where key like ?').run(`${ns}.%`);
    await database.close();
  });

  it('is a positive integer exported by @adminforge/schemas', () => {
    expect(Number.isInteger(CONTENT_SCHEMA_VERSION) && CONTENT_SCHEMA_VERSION >= 1).toBe(true);
  });

  it('publish stamps every new row with the current version, and the record carries it', async () => {
    const store = new DbDefinitionStore(database.db);
    await store.publish([entry('a'), entry('b')]);
    expect(versionOf('a')).toBe(CONTENT_SCHEMA_VERSION);
    expect((await store.get('page', `${ns}.a`))?.schemaVersion).toBe(CONTENT_SCHEMA_VERSION);
  });

  it('a dry run lists rows from an older schema version and whether they still pass; a publish restamps them', async () => {
    // As after an upgrade to schema version N+1: the rows were published under N.
    const next = CONTENT_SCHEMA_VERSION + 1;
    const upgraded = new DbDefinitionStore(database.db, () => new Date(), null, { schemaVersion: next });
    await new DbDefinitionStore(database.db).publish([entry('old', '1.0.0'), entry('old', '1.1.0')]);
    const body = JSON.parse(
      (
        database.sqlite
          .prepare('select body from definitions where key = ? and version = ?')
          .get(`${ns}.old`, '1.0.0') as { body: string }
      ).body,
    ) as Record<string, unknown>;
    database.sqlite
      .prepare('update definitions set body = ? where key = ? and version = ?')
      .run(JSON.stringify({ ...body, layout: 'not a list' }), `${ns}.old`, '1.0.0');

    const dry = await upgraded.publish([entry('a')], { dryRun: true });
    const old = dry.olderSchema!.filter((r) => r.key.startsWith(`${ns}.`));
    expect(old).toEqual(
      expect.arrayContaining([
        {
          kind: 'page',
          key: `${ns}.old`,
          version: '1.0.0',
          status: 'published',
          schemaVersion: CONTENT_SCHEMA_VERSION,
          problems: [expect.stringMatching(/^layout: /)],
        },
        {
          kind: 'page',
          key: `${ns}.old`,
          version: '1.1.0',
          status: 'published',
          schemaVersion: CONTENT_SCHEMA_VERSION,
          problems: [],
        },
      ]),
    );
    expect(old.map((r) => `${r.key}@${r.version}`).sort()).toEqual(
      [`${ns}.a@1.0.0`, `${ns}.b@1.0.0`, `${ns}.old@1.0.0`, `${ns}.old@1.1.0`].sort(),
    );
    // A dry run writes nothing.
    expect(versionOf('a')).toBe(CONTENT_SCHEMA_VERSION);

    // Publishing the same content (unchanged versions) under the new schema stamps them; the rest stay listed.
    const real = await upgraded.publish([entry('a'), entry('old', '1.1.0')]);
    expect(real).toMatchObject({ created: 0, unchanged: 2, applied: true });
    expect(versionOf('a')).toBe(next);
    expect(versionOf('old', '1.1.0')).toBe(next);
    const after = (await upgraded.publish([], { dryRun: true })).olderSchema!.filter((r) =>
      r.key.startsWith(`${ns}.`),
    );
    expect(after.map((r) => `${r.key}@${r.version}`).sort()).toEqual([`${ns}.b@1.0.0`, `${ns}.old@1.0.0`]);
    // Only dry runs list them.
    expect(real.olderSchema).toBeUndefined();
  });

  it('the migration is a plain ADD COLUMN with a default, listed after 0001 in the journal', () => {
    const dir = migrationsDir();
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.slice(0, 3)).toEqual([
      '0000_baseline',
      '0001_append_only',
      '0002_definitions_schema_version',
    ]);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const sql = readFileSync(path.join(dir, '0002_definitions_schema_version.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .trim();
    expect(sql).toBe('ALTER TABLE `definitions` ADD `schema_version` integer DEFAULT 1 NOT NULL;');
  });

  it('upgrading a file from 0001 keeps its rows and gives them schema version 1', async () => {
    // A file as it was before 0002: migrated with 0000 and 0001 only (a copy of the folder whose journal stops there).
    const local = createDatabase(path.join(scratch(), 'adminforge.db'), { name: 'cli', pollSignals: false });
    try {
      const full = migrationsDir();
      const journal = JSON.parse(readFileSync(path.join(full, 'meta', '_journal.json'), 'utf8')) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      const old = path.join(scratch(), 'migrations-0001');
      mkdirSync(path.join(old, 'meta'), { recursive: true });
      const kept = journal.entries.filter((e) => e.idx <= 1);
      for (const e of kept) copyFileSync(path.join(full, `${e.tag}.sql`), path.join(old, `${e.tag}.sql`));
      writeFileSync(path.join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
      migrateDatabase(local, old);
      const applied = () =>
        (local.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n;
      const total = journal.entries.length;
      expect(applied()).toBe(2);
      const cols = () =>
        (local.sqlite.prepare('pragma table_info(definitions)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
      expect(cols()).not.toContain('schema_version');
      const e = entry('legacy');
      local.sqlite
        .prepare(
          `insert into definitions (id, kind, key, version, status, source, body, sha256, created_at, published_at)
           values (?, 'page', ?, '1.0.0', 'published', 'git', ?, ?, ?, ?)`,
        )
        .run(randomUUID(), e.def.id, JSON.stringify(e.def), e.sha256, Date.now(), Date.now());

      migrateDatabase(local);
      expect(applied()).toBe(total);
      expect(cols()).toContain('schema_version');
      const rec = await new DbDefinitionStore(local.db).get('page', e.def.id);
      expect(rec).toMatchObject({ version: '1.0.0', schemaVersion: 1, def: { title: 'Page legacy' } });
    } finally {
      await local.close();
    }
  });
});
