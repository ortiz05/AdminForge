import { getMe, makeApp, mockConfig, mockLogin, type TestApp } from './helpers';

// D-11: a list page's KPI strip can be collapsed, and the choice is remembered per page in the person's preferences
// (`kpiCollapsed`: page keys). It changes on a click, like the open navigation sections, so it is saved but not
// audited; the list is bounded.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp(mockConfig());
});
afterEach(async () => {
  await t.app.close();
});

async function putter() {
  const { cookie, csrf } = await mockLogin(t.app);
  const put = (body: object) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: body,
    });
  return { cookie, put };
}

describe('PUT /api/me/prefs kpiCollapsed', () => {
  it('remembers the pages whose key figures are collapsed, without an audit event', async () => {
    const { cookie, put } = await putter();
    expect((await put({ kpiCollapsed: ['identity.users', 'azure.resources'] })).statusCode).toBe(200);
    expect(t.audit.rows.filter((r) => r.action === 'prefs.updated')).toEqual([]);
    const { me } = await getMe(t.app, cookie);
    expect(me!.prefs.kpiCollapsed).toEqual(['identity.users', 'azure.resources']);
  });

  it('refuses more than 100 pages, or a key that is not a page key', async () => {
    const { put } = await putter();
    expect(
      (await put({ kpiCollapsed: Array.from({ length: 101 }, (_, i) => `identity.p${i}`) })).statusCode,
    ).toBe(400);
    expect((await put({ kpiCollapsed: ['<script>'] })).statusCode).toBe(400);
  });
});
