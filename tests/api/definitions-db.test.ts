import { createHash, randomUUID } from 'node:crypto';
import { SqliteSettingsStore } from '@adminforge/api/src/admin/settings-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import {
  CachedDbSource,
  DbDefinitionStore,
  DEFINITIONS_CHANNEL,
  registryFrom,
  type DefinitionsChanged,
  type PublishEntry,
} from '@adminforge/api/src/definitions';
import type { PortalEvent } from '@adminforge/api/src/events/bus';
import { DefinitionResponse, validateDefinition } from '@adminforge/schemas';
import { testDatabasePath } from './db';
import { makeApp, mockConfig, mockLogin } from './helpers';

const file = await testDatabasePath();

const ns = `t${Date.now().toString(36)}`;
function entry(name: string, version: string, opts: { title?: string; status?: string } = {}): PublishEntry {
  const raw = {
    kind: 'page',
    id: `${ns}.${name}`,
    version,
    title: opts.title ?? name,
    owner: 'test-team',
    template: 'list-detail',
    ...(opts.status ? { status: opts.status } : {}),
    datasources: { rows: { source: 'static', data: [1] } },
    layout: [{ widget: 'kpi', data: 'rows' }],
  };
  const r = validateDefinition(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return {
    def: r.def,
    sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    file: `pages/${ns}/${name}.page.yaml`,
  };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('published definitions (SQLite)', () => {
  let database: Database;
  let store: DbDefinitionStore;
  beforeAll(() => {
    // The publisher's connection (the CLI's `publish`, or the portal editor): it announces what it published.
    database = createDatabase(file, { name: 'cli' });
    store = new DbDefinitionStore(database.db, () => new Date(), database.signals);
  });
  afterAll(async () => {
    database.sqlite.prepare('delete from definitions where key like ?').run(`${ns}.%`);
    database.sqlite.prepare("delete from settings where key like 'test.%'").run();
    await database.close();
  });

  it('publish is idempotent by sha256, refuses reused versions with other content and older versions, all-or-nothing', async () => {
    const a1 = entry('a', '1.0.0');
    const first = await store.publish([a1, entry('b', '1.0.0')]);
    expect(first).toMatchObject({ created: 2, unchanged: 0, refused: 0, applied: true, notified: true });
    expect(await store.publish([a1])).toMatchObject({
      created: 0,
      unchanged: 1,
      applied: true,
      notified: false,
    });

    const changed = { ...entry('a', '1.0.0', { title: 'Changed' }) };
    const refused = await store.publish([changed, entry('c', '1.0.0')]);
    expect(refused).toMatchObject({ refused: 1, applied: false, notified: false });
    expect(refused.items.find((i) => i.key === `${ns}.a`)!.reason).toMatch(
      /already published with different content/,
    );
    // All-or-nothing: c was not written.
    expect(await store.get('page', `${ns}.c`)).toBeNull();

    expect((await store.publish([entry('a', '1.1.0', { title: 'A 1.1' })])).created).toBe(1);
    const older = await store.publish([entry('a', '1.0.5')]);
    expect(older.items[0]).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/older than the published 1\.1\.0/),
    });

    const dry = await store.publish([entry('d', '1.0.0')], { dryRun: true });
    expect(dry).toMatchObject({ created: 1, applied: false });
    expect(await store.get('page', `${ns}.d`)).toBeNull();
  });

  it('latest = highest version; retired hides the key but exact versions still resolve (runs pin them)', async () => {
    expect((await store.get('page', `${ns}.a`))!.version).toBe('1.1.0');
    expect((await store.get('page', `${ns}.a`, '1.0.0'))!.def.title).toBe('a');
    await store.publish([entry('a', '2.0.0', { status: 'retired' })]);
    expect(await store.get('page', `${ns}.a`)).toBeNull();
    expect((await store.get('page', `${ns}.a`, '2.0.0'))!.status).toBe('retired');
    expect((await store.get('page', `${ns}.a`, '1.1.0'))!.status).toBe('published');
    const keys = (await store.list('page')).map((r) => r.key).filter((k) => k.startsWith(`${ns}.`));
    expect(keys).toEqual([`${ns}.b`]);
    expect((await store.versions('page', `${ns}.a`)).map((v) => v.version)).toEqual([
      '2.0.0',
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('the definitions_changed signal reaches the publisher at once and another process on its next poll', async () => {
    // Another process on the same file (the API) with its own cached source, subscribed before the publish.
    const api = createDatabase(file, { name: 'api' });
    const local: string[] = [];
    const remote: string[] = [];
    const offLocal = database.signals.on(DEFINITIONS_CHANNEL, (p) => local.push(p));
    api.signals.on(DEFINITIONS_CHANNEL, (p) => remote.push(p));
    const cached = new CachedDbSource(new DbDefinitionStore(api.db), { signals: api.signals });
    const changes: DefinitionsChanged[] = [];
    cached.onChange((c) => changes.push(c));
    const reg = registryFrom(cached, 'db');
    try {
      expect((await reg.resolve('page', `${ns}.b`)).version).toBe('1.0.0');
      expect(await store.publish([entry('b', '1.2.0')])).toMatchObject({ created: 1, notified: true });
      const payload = { keys: [`page:${ns}.b`] };
      expect(local.map((p) => JSON.parse(p))).toEqual([payload]);
      // The other process learns of it from the signals table (its timer polls too; a poll by hand is just sooner).
      api.signals.poll();
      expect(remote.map((p) => JSON.parse(p))).toEqual([payload]);
      expect(changes).toEqual([payload]);
      expect((await reg.resolve('page', `${ns}.b`)).version).toBe('1.2.0');
      // The publisher never gets its own signal a second time from the table.
      database.signals.poll();
      expect(local).toHaveLength(1);
    } finally {
      offLocal();
      await reg.close();
      await api.close();
    }
  });

  it('CONTENT_SOURCE=db: the API serves the published version and picks up a new publish via the signal', async () => {
    const t = await makeApp(mockConfig({ CONTENT_SOURCE: 'db', DATABASE_PATH: file }), {
      database: createDatabase(file),
    });
    const { cookie } = await mockLogin(t.app);
    const get = async () =>
      DefinitionResponse.parse(
        (
          await t.app.inject({ method: 'GET', url: `/api/definitions/page/${ns}.b`, headers: { cookie } })
        ).json(),
      );
    expect((await get()).version).toBe('1.2.0');
    // Published from this suite's connection (another process, as far as the app's connection can tell): the app's
    // own poll timer picks it up.
    await store.publish([entry('b', '1.3.0')]);
    await until(async () => (await get()).version === '1.3.0');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/definitions/page/${ns}.b?version=1.0.0`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    // app.close() also closes the database it was given.
    await t.app.close();
  });

  it('SqliteSettingsStore: versions increase; a stale expected version is refused', async () => {
    const settings = new SqliteSettingsStore(database.db);
    const now = new Date('2026-10-15T12:00:00.000Z');
    const first = await settings.put(
      'test.appearance',
      { a: 1 },
      { updatedBy: 'u', now, expectedVersion: 0 },
    );
    expect(first).toMatchObject({ version: 1, value: { a: 1 } });
    expect(
      await settings.put('test.appearance', { a: 2 }, { updatedBy: 'u', now, expectedVersion: 0 }),
    ).toBeNull();
    expect(await settings.put('test.appearance', { a: 2 }, { updatedBy: 'u', now })).toMatchObject({
      version: 2,
    });
    expect(await settings.get<{ a: number }>('test.appearance')).toMatchObject({
      version: 2,
      value: { a: 2 },
    });
  });

  it('recorded run events are relayed as run.updated to the initiator only (run/step, not log lines)', async () => {
    // The run worker is part of the API process (ADR-016): the repository hands each recorded event to the browsers'
    // event bus directly (runs/module.ts), with no database round trip in between.
    const t = await makeApp(mockConfig({ DATABASE_PATH: file }), { database: createDatabase(file) });
    try {
      const got: PortalEvent[] = [];
      t.app.ctx.events.subscribe((e) => got.push(e));
      const repo = t.app.runs.repo;
      const run = (initiatorOid: string | null) =>
        repo.insertRun({
          id: randomUUID(),
          identityName: null,
          kind: 'playbook',
          definitionKey: `${ns}.relay`,
          definitionVersion: '1.0.0',
          definitionSha256: 'a'.repeat(64),
          dryRun: false,
          trigger: 'interactive',
          identity: 'delegated',
          initiatorOid,
          initiatorUpn: null,
          sessionHash: null,
          scheduleId: null,
          parentRunId: null,
          inputs: {},
          correlationId: randomUUID(),
        });
      const r1 = await run('u1');
      const r2 = await run(null);
      await repo.appendEvent(
        r1.id,
        { type: 'log', level: 'info', data: { message: 'hi' } },
        { v: 1, runId: r1.id, type: 'log', initiatorOid: 'u1' },
      );
      await repo.appendEvent(
        r1.id,
        { type: 'status', data: { scope: 'run', status: 'running' } },
        { v: 1, runId: r1.id, type: 'run', status: 'running', initiatorOid: 'u1' },
      );
      await repo.appendEvent(
        r2.id,
        { type: 'status', stepSeq: 1, data: { scope: 'step', status: 'succeeded' } },
        { v: 1, runId: r2.id, type: 'step', status: 'succeeded' },
      );
      expect(
        got
          .filter((e) => e.type === 'run.updated')
          .map((e) => [(e.data as { runId: string }).runId, e.userOid]),
      ).toEqual([
        [r1.id, 'u1'],
        [r2.id, undefined],
      ]);
    } finally {
      database.sqlite.prepare('delete from runs where definition_key = ?').run(`${ns}.relay`);
      // app.close() also closes the database it was given.
      await t.app.close();
    }
  });

  it('signal payloads are JSON the cache understands; anything else, or missed signals, reload everything', async () => {
    const api = createDatabase(file, { name: 'api' });
    const cached = new CachedDbSource(new DbDefinitionStore(api.db), { signals: api.signals });
    const changes: DefinitionsChanged[] = [];
    cached.onChange((c) => changes.push(c));
    try {
      cached.invalidate({ keys: ['page:x.y'] });
      cached.invalidate({ all: true });
      expect(changes).toEqual([{ keys: ['page:x.y'] }, { all: true }]);

      changes.length = 0;
      database.signals.publish(DEFINITIONS_CHANNEL, 'not json');
      api.signals.poll();
      expect(changes).toEqual([{ all: true }]);

      // Signals the API never read (pruned while it was paused, simulated by deleting the row): it can't know what
      // changed, so it drops everything — the equivalent of a LISTEN reconnect.
      changes.length = 0;
      database.signals.publish(DEFINITIONS_CHANNEL, JSON.stringify({ keys: ['page:x.missed'] }));
      database.sqlite.prepare('delete from signals where id = (select max(id) from signals)').run();
      database.signals.publish(DEFINITIONS_CHANNEL, JSON.stringify({ keys: ['page:x.next'] }));
      api.signals.poll();
      expect(changes).toEqual([{ all: true }, { keys: ['page:x.next'] }]);
    } finally {
      await cached.close();
      await api.close();
    }
  });
});
