import { createHash } from 'node:crypto';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { DbDefinitionStore, type PublishEntry } from '@adminforge/api/src/definitions';
import { validateDefinition } from '@adminforge/schemas';
import { testDatabaseUrl } from './db';

// Published definitions keep the order they were written in: params and inputs are form fields (in that order), and
// people read datasources top to bottom. The column was jsonb, which sorts keys shorter-first; it is json now, and a
// publish restores bodies stored in sorted order.
const url = await testDatabaseUrl();
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

describe.skipIf(!url)('published definitions keep their authored key order (Postgres)', () => {
  let database: Database;
  let store: DbDefinitionStore;
  beforeAll(() => {
    database = createDatabase(url!);
    store = new DbDefinitionStore(database.db);
  });
  afterAll(async () => {
    await database.pool.query('delete from definitions where key like $1', [`${ns}.%`]);
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
  });

  it('a publish restores a body stored with sorted keys (the jsonb era) without a new version', async () => {
    // What jsonb did to it: keys sorted shorter-first.
    await database.pool.query(`update definitions set body = (body::jsonb)::json where key = $1`, [
      `${ns}.order`,
    ]);
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
