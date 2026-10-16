import { getMe, makeApp, mockConfig, mockLogin, type TestApp } from './helpers';

// Settings changes are audited; navigation state (recent pages, closed nav sections) changes on every click and
// would bury real events, so it is saved but not audited.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp(mockConfig());
});
afterEach(async () => {
  await t.app.close();
});

describe('PUT /api/me/prefs and the audit log', () => {
  it('saves navigation state without auditing it, and still audits settings', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const put = (body: object) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/me/prefs',
        headers: { cookie, 'x-adminforge-csrf': csrf },
        payload: body,
      });

    expect((await put({ navOpenSections: ['identity', 'azure'] })).statusCode).toBe(200);
    expect((await put({ recents: ['/p/azure.resources'] })).statusCode).toBe(200);
    expect(t.audit.rows.filter((r) => r.action === 'prefs.updated')).toEqual([]);

    expect((await put({ density: 'compact', navOpenSections: ['identity'] })).statusCode).toBe(200);
    expect(t.audit.rows.filter((r) => r.action === 'prefs.updated').map((r) => r.details)).toEqual([
      { changed: ['density', 'navOpenSections'] },
    ]);

    const { me } = await getMe(t.app, cookie);
    expect(me!.prefs).toEqual({
      navOpenSections: ['identity'],
      recents: ['/p/azure.resources'],
      density: 'compact',
    });
  });

  it('rejects malformed navigation sections', async () => {
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { navOpenSections: Array.from({ length: 31 }, (_, i) => `s${i}`) },
    });
    expect(res.statusCode).toBe(400);
  });
});
