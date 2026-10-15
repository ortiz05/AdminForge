import { createHash } from 'node:crypto';
import { PgSettingsStore } from '@adminforge/api/src/admin/settings-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { CachedDbSource, DbDefinitionStore, DEFINITIONS_CHANNEL, PgListener, registryFrom, type DefinitionsChanged, type PublishEntry } from '@adminforge/api/src/definitions';
import { EventBus, type PortalEvent } from '@adminforge/api/src/events/bus';
import { DefinitionResponse, validateDefinition } from '@adminforge/schemas';
import { testDatabaseUrl } from './db';
import { makeApp, mockConfig, mockLogin } from './helpers';

const url = await testDatabaseUrl();

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
  return { def: r.def, sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'), file: `pages/${ns}/${name}.page.yaml` };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!url)('published definitions (Postgres)', () => {
  let database: Database;
  let store: DbDefinitionStore;
  beforeAll(() => {
    database = createDatabase(url!);
    store = new DbDefinitionStore(database.db);
  });
  afterAll(async () => {
    await database.pool.query('delete from definitions where key like $1', [`${ns}.%`]);
    await database.pool.query("delete from settings where key like 'test.%'");
    await database.close();
  });

  it('publish is idempotent by sha256, refuses reused versions with other content and older versions, all-or-nothing', async () => {
    const a1 = entry('a', '1.0.0');
    const first = await store.publish([a1, entry('b', '1.0.0')]);
    expect(first).toMatchObject({ created: 2, unchanged: 0, refused: 0, applied: true, notified: true });
    expect(await store.publish([a1])).toMatchObject({ created: 0, unchanged: 1, applied: true, notified: false });

    const changed = { ...entry('a', '1.0.0', { title: 'Changed' }) };
    const refused = await store.publish([changed, entry('c', '1.0.0')]);
    expect(refused).toMatchObject({ refused: 1, applied: false, notified: false });
    expect(refused.items.find((i) => i.key === `${ns}.a`)!.reason).toMatch(/already published with different content/);
    // All-or-nothing: c was not written.
    expect(await store.get('page', `${ns}.c`)).toBeNull();

    expect((await store.publish([entry('a', '1.1.0', { title: 'A 1.1' })])).created).toBe(1);
    const older = await store.publish([entry('a', '1.0.5')]);
    expect(older.items[0]).toMatchObject({ action: 'refused', reason: expect.stringMatching(/older than the published 1\.1\.0/) });

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
    expect((await store.versions('page', `${ns}.a`)).map((v) => v.version)).toEqual(['2.0.0', '1.1.0', '1.0.0']);
  });

  it('NOTIFY definitions_changed reaches every listener and invalidates the cached source', async () => {
    const seen: string[] = [];
    const listener = new PgListener(url!, DEFINITIONS_CHANNEL, (p) => seen.push(p));
    await listener.start();
    const cached = new CachedDbSource(store, { listenUrl: url! });
    const changes: DefinitionsChanged[] = [];
    cached.onChange((c) => changes.push(c));
    const reg = registryFrom(cached, 'db');
    expect((await reg.resolve('page', `${ns}.b`)).version).toBe('1.0.0');
    // Give the cached source's own LISTEN connection time to come up.
    await new Promise((r) => setTimeout(r, 300));
    await store.publish([entry('b', '1.2.0')]);
    await until(() => seen.some((p) => p.includes(`page:${ns}.b`)));
    expect(JSON.parse(seen.find((p) => p.includes(`${ns}.b`))!)).toEqual({ keys: [`page:${ns}.b`] });
    await until(() => changes.length > 0);
    expect((await reg.resolve('page', `${ns}.b`)).version).toBe('1.2.0');
    await listener.stop();
    await reg.close();
  });

  it('CONTENT_SOURCE=db: the API serves the published version and picks up a new publish via NOTIFY', async () => {
    const t = await makeApp(mockConfig({ CONTENT_SOURCE: 'db', DATABASE_URL: url! }), { database: createDatabase(url!) });
    const { cookie } = await mockLogin(t.app);
    const get = async () => DefinitionResponse.parse((await t.app.inject({ method: 'GET', url: `/api/definitions/page/${ns}.b`, headers: { cookie } })).json());
    expect((await get()).version).toBe('1.2.0');
    await new Promise((r) => setTimeout(r, 300));
    await store.publish([entry('b', '1.3.0')]);
    await until(async () => (await get()).version === '1.3.0');
    expect((await t.app.inject({ method: 'GET', url: `/api/definitions/page/${ns}.b?version=1.0.0`, headers: { cookie } })).statusCode).toBe(200);
    // app.close() also closes the database it was given.
    await t.app.close();
  });

  it('PgSettingsStore: versions increase; a stale expected version is refused', async () => {
    const settings = new PgSettingsStore(database.db);
    const now = new Date('2026-10-15T12:00:00.000Z');
    const first = await settings.put('test.appearance', { a: 1 }, { updatedBy: 'u', now, expectedVersion: 0 });
    expect(first).toMatchObject({ version: 1, value: { a: 1 } });
    expect(await settings.put('test.appearance', { a: 2 }, { updatedBy: 'u', now, expectedVersion: 0 })).toBeNull();
    expect(await settings.put('test.appearance', { a: 2 }, { updatedBy: 'u', now })).toMatchObject({ version: 2 });
    expect(await settings.get<{ a: number }>('test.appearance')).toMatchObject({ version: 2, value: { a: 2 } });
  });

  it('NOTIFY run_events is relayed as run.updated to the initiator only (run/step, not log lines)', async () => {
    const bus = new EventBus();
    const cached = new CachedDbSource(store);
    bus.wire({ definitions: cached, databaseUrl: url!, database });
    const got: PortalEvent[] = [];
    bus.subscribe((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 400));
    const notify = (p: object) => database.pool.query('select pg_notify($1, $2)', ['run_events', JSON.stringify(p)]);
    await notify({ v: 1, runId: `${ns}-r1`, type: 'log', initiatorOid: 'u1' });
    await notify({ v: 1, runId: `${ns}-r1`, type: 'run', status: 'running', initiatorOid: 'u1' });
    await notify({ v: 1, runId: `${ns}-r2`, type: 'step', status: 'succeeded' });
    await until(() => got.filter((e) => e.type === 'run.updated').length >= 2);
    expect(got.filter((e) => e.type === 'run.updated').map((e) => [(e.data as { runId: string }).runId, e.userOid])).toEqual([
      [`${ns}-r1`, 'u1'],
      [`${ns}-r2`, undefined],
    ]);
    await bus.close();
    await cached.close();
  });

  it('notify payloads are JSON the cache understands', async () => {
    const cached = new CachedDbSource(store);
    const changes: DefinitionsChanged[] = [];
    cached.onChange((c) => changes.push(c));
    cached.invalidate({ keys: ['page:x.y'] });
    cached.invalidate({ all: true });
    expect(changes).toEqual([{ keys: ['page:x.y'] }, { all: true }]);
    await cached.close();
  });
});
