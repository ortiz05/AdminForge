import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { PgViewStore } from '@adminforge/api/src/views/store';
import { ApiErrorBody, SavedView, SavedViewList } from '@adminforge/schemas';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { testDatabaseUrl } from './db';
import { mockLogin } from './helpers';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

const OTHER = '99999999-0000-4000-8000-000000000099';

describe('saved views (/api/views)', () => {
  it('create, list (own + shared), rename/share, delete; owners only; audited', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    const create = await t.app.inject({ method: 'POST', url: '/api/views', headers: h, payload: { page: 'identity.users', name: 'Guests', state: { params: { userType: 'Guest' }, columns: ['displayName'] } } });
    expect(create.statusCode).toBe(201);
    const view = SavedView.parse(create.json());
    expect(view).toMatchObject({ page: 'identity.users', name: 'Guests', shared: false, mine: true, owner: '00000000-0000-4000-8000-0000000000a1' });

    expect((await t.app.inject({ method: 'POST', url: '/api/views', headers: h, payload: { page: 'identity.users', name: 'guests', state: {} } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/views', headers: h, payload: { page: 'identity.nope', name: 'x', state: {} } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/views', headers: h, payload: { page: 'identity.users', name: 'big', state: { blob: 'x'.repeat(17_000) } } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/views', headers: { cookie }, payload: { page: 'identity.users', name: 'x', state: {} } })).statusCode).toBe(403);

    // A view someone else shared on the same page, and one they kept private.
    await t.app.ctx.views.create({ userOid: OTHER, pageKey: 'identity.users', name: 'Team view', state: {}, shared: true }, new Date());
    await t.app.ctx.views.create({ userOid: OTHER, pageKey: 'identity.users', name: 'Private', state: {}, shared: false }, new Date());
    const list = SavedViewList.parse((await t.app.inject({ method: 'GET', url: '/api/views?page=identity.users', headers: { cookie } })).json());
    expect(list.items.map((v) => [v.name, v.mine])).toEqual([
      ['Guests', true],
      ['Team view', false],
    ]);
    expect((await t.app.inject({ method: 'GET', url: '/api/views', headers: { cookie } })).statusCode).toBe(400);

    const patched = await t.app.inject({ method: 'PATCH', url: `/api/views/${view.id}`, headers: h, payload: { name: 'Guests only', shared: true } });
    expect(SavedView.parse(patched.json())).toMatchObject({ name: 'Guests only', shared: true });
    expect((await t.app.inject({ method: 'PATCH', url: `/api/views/${view.id}`, headers: h, payload: {} })).statusCode).toBe(400);
    const team = list.items.find((v) => v.name === 'Team view')!;
    const notMine = await t.app.inject({ method: 'PATCH', url: `/api/views/${team.id}`, headers: h, payload: { name: 'Mine now' } });
    expect(notMine.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/views/does-not-exist', headers: h, payload: { name: 'x' } })).statusCode).toBe(404);

    // Portal.Admin may remove a view someone else shared; others may not.
    await t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: h, payload: { roles: ['Portal.Reader'] } });
    expect(ApiErrorBody.parse((await t.app.inject({ method: 'DELETE', url: `/api/views/${team.id}`, headers: h })).json()).error.code).toBe('forbidden');
    await t.app.inject({ method: 'POST', url: '/auth/mock/state', headers: h, payload: { roles: ['Portal.Reader', 'Portal.Admin'] } });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/views/${team.id}`, headers: h })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/views/${view.id}`, headers: h })).statusCode).toBe(204);
    expect(SavedViewList.parse((await t.app.inject({ method: 'GET', url: '/api/views?page=identity.users', headers: { cookie } })).json()).items).toEqual([]);

    expect(t.audit.rows.filter((r) => r.action.startsWith('view.')).map((r) => r.action)).toEqual(['view.created', 'view.updated', 'view.deleted', 'view.deleted']);
    await t.app.close();
  });
});

const url = await testDatabaseUrl();

describe.skipIf(!url)('PgViewStore', () => {
  let database: Database;
  const page = `test.views-${Date.now()}`;
  beforeAll(() => {
    database = createDatabase(url!);
  });
  afterAll(async () => {
    await database.pool.query('delete from saved_views where page_key = $1', [page]);
    await database.close();
  });

  it('lists own + shared views by name; updates and deletes by id', async () => {
    const store = new PgViewStore(database.db);
    const now = new Date('2026-10-15T12:00:00.000Z');
    const mine = await store.create({ userOid: 'me', pageKey: page, name: 'B mine', state: { params: { a: 1 } }, shared: false }, now);
    await store.create({ userOid: 'other', pageKey: page, name: 'A shared', state: {}, shared: true }, now);
    await store.create({ userOid: 'other', pageKey: page, name: 'C private', state: {}, shared: false }, now);
    expect((await store.list(page, 'me')).map((v) => v.name)).toEqual(['A shared', 'B mine']);
    expect((await store.own(page, 'me')).map((v) => v.name)).toEqual(['B mine']);
    const later = new Date(now.getTime() + 1000);
    expect(await store.update(mine.id, { shared: true, state: { params: { a: 2 } } }, later)).toMatchObject({ shared: true, state: { params: { a: 2 } }, updatedAt: later });
    expect(await store.get('not-a-uuid')).toBeNull();
    await store.delete(mine.id);
    expect(await store.get(mine.id)).toBeNull();
    expect(await store.countFor(page)).toBe(2);
  });
});
