import { createHash } from 'node:crypto';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { CachedDbSource, DbDefinitionStore, type PublishEntry } from '@adminforge/api/src/definitions';
import { validateDefinition } from '@adminforge/schemas';
import { testDatabasePath } from './db';
import { makeApp, mockConfig, mockLogin } from './helpers';

// The published store (CONTENT_SOURCE=db, production) answers a retired key the way the files do: 409
// definition_retired with the retirement note, its exact versions still resolvable; a key never published is a 404
// with a hint for the person.
const file = await testDatabasePath();
const ns = `t${Date.now().toString(36)}`;

function entry(name: string, version: string, extra: Record<string, unknown> = {}): PublishEntry {
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

const RETIRED = {
  status: 'retired',
  summary: 'Retired — merged into Users (identity.users). The old list of users.',
};

describe('retired and unknown keys (SQLite)', () => {
  let database: Database;
  let store: DbDefinitionStore;
  beforeAll(async () => {
    database = createDatabase(file, { name: 'cli' });
    store = new DbDefinitionStore(database.db, () => new Date(), database.signals);
    const result = await store.publish([
      entry('old', '1.0.0'),
      entry('old', '1.1.0', RETIRED),
      entry('live', '1.0.0'),
    ]);
    expect(result.applied).toBe(true);
  });
  afterAll(async () => {
    database.sqlite.prepare('delete from definitions where key like ?').run(`${ns}.%`);
    await database.close();
  });

  it('the store hands out the retired latest version, and nothing for a live or unknown key', async () => {
    const retired = await store.retired('page', `${ns}.old`);
    expect(retired).toMatchObject({ version: '1.1.0', status: 'retired' });
    expect(await store.retired('page', `${ns}.live`)).toBeNull();
    expect(await store.retired('page', `${ns}.nope`)).toBeNull();
    // Cached like every other read, and dropped when that key changes.
    const cached = new CachedDbSource(store);
    expect((await cached.retired('page', `${ns}.old`))?.version).toBe('1.1.0');
    await store.publish([entry('old', '2.0.0')]);
    cached.invalidate({ keys: [`page:${ns}.old`] });
    expect(await cached.retired('page', `${ns}.old`)).toBeNull();
    expect((await cached.get('page', `${ns}.old`))?.version).toBe('2.0.0');
  });

  it('the API answers 409 definition_retired with the note; exact versions still load; unknown is a 404', async () => {
    await store.publish([entry('gone', '1.0.0'), entry('gone', '1.1.0', RETIRED)]);
    const t = await makeApp(mockConfig({ CONTENT_SOURCE: 'db', DATABASE_PATH: file }), {
      database: createDatabase(file),
    });
    try {
      const { cookie, csrf } = await mockLogin(t.app);
      const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
      const retired = await get(`/api/definitions/page/${ns}.gone`);
      expect(retired.statusCode).toBe(409);
      expect(retired.json().error).toMatchObject({
        code: 'definition_retired',
        message: `Page gone is retired. Merged into Users (identity.users).`,
        hint: 'Open what you need from the navigation, or search for it.',
      });
      expect((await get(`/api/definitions/page/${ns}.gone?version=1.0.0`)).statusCode).toBe(200);
      expect((await get(`/api/definitions/page/${ns}.gone?version=1.1.0`)).json()).toMatchObject({
        status: 'retired',
      });

      // The page's data: retired by its current version, and by the version the tab loaded.
      for (const version of [undefined, '1.0.0']) {
        const data = await t.app.inject({
          method: 'POST',
          url: '/api/datasources/execute-many',
          headers: { cookie, 'x-adminforge-csrf': csrf },
          payload: { page: `${ns}.gone`, ...(version ? { version } : {}) },
        });
        expect(data.statusCode).toBe(409);
        expect(data.json().error.message).toMatch(
          /is retired and is no longer available\. Merged into Users/,
        );
      }

      const unknown = await get(`/api/definitions/page/${ns}.nope`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.hint).toBe('Check the address, or open it from the navigation.');
    } finally {
      await t.app.close();
    }
  });
});
