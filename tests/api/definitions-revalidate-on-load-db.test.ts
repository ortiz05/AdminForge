import { createHash } from 'node:crypto';
import path from 'node:path';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import {
  CachedDbSource,
  DbDefinitionStore,
  registryFrom,
  type PublishEntry,
} from '@adminforge/api/src/definitions';
import { AppError } from '@adminforge/api/src/errors';
import { loadContentDir, validateDefinition } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import { testDatabasePath } from './db';
import { makeApp, mockConfig, mockLogin } from './helpers';

// Published rows are not trusted on load (S-07): `publish` validated them, but the file can also be written by
// `db import-postgres`, a restored copy (the loader pod), or anything else with the volume. Each row is parsed with
// its kind's schema when it is first loaded (cached by sha256 and body) and must match its own columns; a row that
// fails is refused — logged once, listed in problems(), answered with a clear error, never run.
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

type Line = { level: string; obj: Record<string, unknown>; msg: string };
const logger = (lines: Line[]) => ({
  warn: (obj: object, msg: string) => lines.push({ level: 'warn', obj: obj as Line['obj'], msg }),
  error: (obj: object, msg: string) => lines.push({ level: 'error', obj: obj as Line['obj'], msg }),
});

const unavailable = (err: unknown) =>
  err instanceof AppError && err.code === 'definition_unavailable' && err.status === 500;

describe('published definitions are re-validated when loaded (SQLite)', () => {
  let database: Database;
  const bodyOf = (name: string, version = '1.0.0') =>
    JSON.parse(
      (
        database.sqlite
          .prepare('select body from definitions where key = ? and version = ?')
          .get(`${ns}.${name}`, version) as { body: string }
      ).body,
    ) as Record<string, unknown>;
  const setBody = (name: string, body: unknown, version = '1.0.0') =>
    database.sqlite
      .prepare('update definitions set body = ? where key = ? and version = ?')
      .run(JSON.stringify(body), `${ns}.${name}`, version);

  beforeAll(async () => {
    database = createDatabase(file, { name: 'cli' });
    const store = new DbDefinitionStore(database.db, () => new Date(), database.signals);
    expect(
      (
        await store.publish([
          entry('good'),
          entry('bad'),
          entry('swapped'),
          entry('pinned', '1.0.0'),
          entry('pinned', '1.1.0'),
        ])
      ).applied,
    ).toBe(true);
  });
  afterAll(async () => {
    database.sqlite.prepare('delete from definitions where key like ?').run(`${ns}.%`);
    await database.close();
  });

  it('a row that no longer passes its schema is refused, logged once, and listed in problems()', async () => {
    // Written behind publish's back: an extra key the page schema doesn't allow.
    setBody('bad', { ...bodyOf('bad'), steps: [{ id: 'x', mode: 'write' }] });
    const lines: Line[] = [];
    const store = new DbDefinitionStore(database.db, () => new Date(), null, { log: logger(lines) });
    for (let i = 0; i < 2; i++) await expect(store.get('page', `${ns}.bad`)).rejects.toSatisfy(unavailable);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: expect.stringMatching(/refused/),
      obj: { kind: 'page', key: `${ns}.bad`, version: '1.0.0', issues: [expect.stringMatching(/steps/)] },
    });
    expect(store.problems()).toEqual([
      {
        file: `page:${ns}.bad@1.0.0 (published)`,
        path: '',
        message: expect.stringMatching(/doesn't pass the content schema/),
      },
    ]);
    // The list leaves it out and keeps everything else.
    const keys = (await store.list('page')).map((r) => r.key);
    expect(keys).toContain(`${ns}.good`);
    expect(keys).not.toContain(`${ns}.bad`);
  });

  it('the error is written for the person in front of the browser', async () => {
    const err = await new DbDefinitionStore(database.db).get('page', `${ns}.bad`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.message).toBe(
      `The published page "${ns}.bad" (version 1.0.0) doesn't pass AdminForge's content checks, so it isn't used.`,
    );
    expect(e.extras.hint).toBe(
      'Ask a Portal Admin to publish the content again from git; the API log names what failed (quote the reference).',
    );
  });

  it("a body copied from another row doesn't pass for it: kind, id and version must match the row", async () => {
    setBody('swapped', { ...bodyOf('good') });
    const store = new DbDefinitionStore(database.db);
    await expect(store.get('page', `${ns}.swapped`)).rejects.toSatisfy(unavailable);
    expect(store.problems()[0]!.message).toMatch(/id is .*\.good, not .*\.swapped/);
  });

  it("a body whose status disagrees with its row is refused (a retired body can't pass as current)", async () => {
    setBody('swapped', { ...bodyOf('good'), id: `${ns}.swapped`, title: 'Page swapped', status: 'retired' });
    const store = new DbDefinitionStore(database.db);
    await expect(store.get('page', `${ns}.swapped`)).rejects.toSatisfy(unavailable);
    expect(store.problems()[0]!.message).toMatch(/status is retired, but the row says published/);
  });

  it('a pinned older version is refused too: a run never executes it', async () => {
    setBody('pinned', { ...bodyOf('pinned'), title: 42 });
    const registry = registryFrom(new CachedDbSource(new DbDefinitionStore(database.db)), 'db');
    await expect(registry.resolve('page', `${ns}.pinned`, '1.0.0')).rejects.toSatisfy(unavailable);
    // The current version is unaffected.
    expect((await registry.resolve('page', `${ns}.pinned`)).version).toBe('1.1.0');
  });

  it('a row put right in place is served again (the cache compares the body, not only the sha256)', async () => {
    const store = new DbDefinitionStore(database.db);
    const good = bodyOf('good');
    setBody('bad', { ...good, id: `${ns}.bad`, title: 'Page bad' });
    expect((await store.get('page', `${ns}.bad`))?.def.title).toBe('Page bad');
    // …and broken again after that: still not trusted.
    setBody('bad', { ...good, id: `${ns}.bad`, title: 7 });
    await expect(store.get('page', `${ns}.bad`)).rejects.toSatisfy(unavailable);
    setBody('bad', { ...good, id: `${ns}.bad`, title: 'Page bad' });
    await store.get('page', `${ns}.bad`);
    expect(store.problems()).toEqual([]);
  });

  it('the API answers definition_unavailable (no schema detail) and the content health check names the row', async () => {
    setBody('bad', { ...bodyOf('bad'), title: { evil: true } });
    const t = await makeApp(mockConfig({ CONTENT_SOURCE: 'db', DATABASE_PATH: file }), {
      database: createDatabase(file),
    });
    try {
      const { cookie } = await mockLogin(t.app);
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/definitions/page/${ns}.bad`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(500);
      const error = res.json().error;
      expect(error).toMatchObject({ code: 'definition_unavailable', correlationId: expect.any(String) });
      expect(JSON.stringify(error)).not.toMatch(/evil|Expected|invalid_type/);
      expect(t.app.ctx.definitions.problems().map((p) => p.file)).toContain(
        `page:${ns}.bad@1.0.0 (published)`,
      );
    } finally {
      await t.app.close();
    }
  });

  // Loads, publishes and re-reads every file in portal/content: seconds on a busy machine.
  it(
    'every definition in portal/content survives the load-time check with its content unchanged',
    { timeout: 60_000 },
    async () => {
      const { definitions, errors } = await loadContentDir(path.join(repoRoot, 'portal', 'content'), {
        references: false,
      });
      expect(errors).toEqual([]);
      const local = createDatabase(await testDatabasePath(), { name: 'cli', pollSignals: false });
      try {
        const store = new DbDefinitionStore(local.db);
        const result = await store.publish(definitions.map((d) => ({ def: d.def, sha256: d.sha256 })));
        expect(result.refused).toBe(0);
        const canonical = (v: unknown): unknown =>
          Array.isArray(v)
            ? v.map(canonical)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                  Object.keys(v)
                    .sort()
                    .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
                )
              : v;
        for (const d of definitions) {
          const rec = await store.get(d.def.kind, d.def.id, d.def.version);
          expect(canonical(rec!.def), d.file).toEqual(canonical(d.def));
        }
        expect(store.problems()).toEqual([]);
      } finally {
        await local.close();
      }
    },
  );
});
