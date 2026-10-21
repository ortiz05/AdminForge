import { createHash } from 'node:crypto';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { DbDefinitionStore, type PublishEntry } from '@adminforge/api/src/definitions';
import { validateDefinition } from '@adminforge/schemas';
import { testDatabasePath } from './db';

// Published definitions keep the order they were written in: params and inputs are form fields (in that order), and
// people read datasources top to bottom. The column is JSON text, which keeps the authored order. Bodies published
// while the Postgres column was jsonb (which sorts keys shorter-first) were imported as they were, and a publish
// restores their order.
const file = await testDatabasePath();
const ns = `t${Date.now().toString(36)}`;

function entry(): PublishEntry {
  const raw = {
    kind: 'report',
    id: `${ns}.order`,
    version: '1.0.0',
    title: 'Order',
    owner: 'test-team',
    // Written longest-first, the opposite of jsonb's order.
    params: {
      includeDisabled: { type: 'boolean', default: false },
      licensedOnly: { type: 'boolean', default: false },
      days: { type: 'number', default: 90 },
    },
    datasources: {
      principals: { source: 'static', data: [1] },
      report: { source: 'static', data: '${ ds.principals }' },
    },
    layout: [{ widget: 'kpi', data: 'report' }],
    export: { formats: ['csv'], data: 'report', columns: 'all' },
  };
  const r = validateDefinition(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { def: r.def, sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}

/** What jsonb did to a body: object keys sorted shorter-first, then bytewise, at every level. */
function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])]));
}

describe('published definitions keep their authored key order (SQLite)', () => {
  let database: Database;
  let store: DbDefinitionStore;
  beforeAll(() => {
    database = createDatabase(file);
    store = new DbDefinitionStore(database.db, () => new Date(), database.signals);
  });
  afterAll(async () => {
    database.sqlite.prepare('delete from definitions where key like ?').run(`${ns}.%`);
    await database.close();
  });

  const keysOf = async () => {
    const rec = await store.get('report', `${ns}.order`);
    const def = rec!.def as unknown as { params: object; datasources: object };
    return { params: Object.keys(def.params), datasources: Object.keys(def.datasources) };
  };

  it('stores and reads back params and datasources in the order they were written', async () => {
    expect(await store.publish([entry()])).toMatchObject({ created: 1, refreshed: 0 });
    expect(await keysOf()).toEqual({
      params: ['includeDisabled', 'licensedOnly', 'days'],
      datasources: ['principals', 'report'],
    });
    // The stored text itself is in the authored order (not only what drizzle hands back).
    const { body } = database.sqlite
      .prepare('select body from definitions where key = ?')
      .get(`${ns}.order`) as { body: string };
    expect(body.indexOf('"includeDisabled"')).toBeLessThan(body.indexOf('"days"'));
  });

  it('a publish restores a body stored with sorted keys (the jsonb era) without a new version', async () => {
    // A body as the import from Postgres left it: same content, keys sorted shorter-first.
    const { body } = database.sqlite
      .prepare('select body from definitions where key = ?')
      .get(`${ns}.order`) as { body: string };
    database.sqlite
      .prepare('update definitions set body = ? where key = ?')
      .run(JSON.stringify(jsonbOrder(JSON.parse(body))), `${ns}.order`);
    expect((await keysOf()).params).toEqual(['days', 'licensedOnly', 'includeDisabled']);

    const again = await store.publish([entry()]);
    expect(again).toMatchObject({ created: 0, unchanged: 1, refreshed: 1, applied: true, notified: true });
    expect(await keysOf()).toEqual({
      params: ['includeDisabled', 'licensedOnly', 'days'],
      datasources: ['principals', 'report'],
    });
    // Already in order: nothing to rewrite, nothing to announce.
    expect(await store.publish([entry()])).toMatchObject({ unchanged: 1, refreshed: 0, notified: false });
  });
});
