import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

// A retired page someone still has a link to (a bookmark, an old e-mail) says it is retired and why — the note its
// summary starts with — instead of "not found"; a key that never existed gets a hint for the person in front of the
// browser, not a CLI command (CLAUDE.md rule 10). Content from the files (CONTENT_SOURCE=fs), the development source.
const RETIRED = `kind: page
id: identity.old-users
version: 1.1.0
title: Old users
summary: >-
  Retired — replaced by Users (identity.users), which also shows guests. Every user with their sign-in state.
status: retired
owner: identity-team
template: list-detail
datasources:
  rows: { source: static, data: [] }
layout:
  - { widget: table, data: rows, columns: [{ field: id, label: Id }] }
`;

const ADMIN_RETIRED = RETIRED.replace('identity.old-users', 'identity.old-admins')
  .replace('Old users', 'Old admins')
  .replace('owner: identity-team', 'owner: identity-team\nrequires:\n  portalRoles: [Portal.Admin]');

const NO_NOTE = RETIRED.replace('identity.old-users', 'identity.old-groups')
  .replace('Old users', 'Old groups')
  .replace(/summary: >-\n.*\n/, 'summary: Groups as they were.\n');

describe('retired and unknown keys (files)', () => {
  let env: ContentEnv;
  beforeAll(() => {
    env = setupContent();
    env.write('pages/identity/old-users.page.yaml', RETIRED);
    env.write('pages/identity/old-admins.page.yaml', ADMIN_RETIRED);
    env.write('pages/identity/old-groups.page.yaml', NO_NOTE);
  });
  afterAll(() => env.cleanup());

  async function signedIn(roles?: string) {
    const t = await fixturesApp(env, roles ? { MOCK_ROLES: roles } : {});
    const { cookie, csrf } = await mockLogin(t.app);
    const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
    const post = (url: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url, headers: { cookie, 'x-adminforge-csrf': csrf }, payload });
    return { t, get, post };
  }

  it('a retired page answers 409 definition_retired with its retirement note and where to go instead', async () => {
    const { t, get } = await signedIn();
    const res = await get('/api/definitions/page/identity.old-users');
    expect(res.statusCode).toBe(409);
    const error = res.json().error;
    expect(error).toMatchObject({
      code: 'definition_retired',
      message: 'Old users is retired. Replaced by Users (identity.users), which also shows guests.',
      hint: 'Open what you need from the navigation, or search for it.',
    });
    expect(error.correlationId).toBeTruthy();
    await t.app.close();
  });

  it('without a note in its summary, a retired page still says it is retired', async () => {
    const { t, get } = await signedIn();
    const res = await get('/api/definitions/page/identity.old-groups');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'definition_retired', message: 'Old groups is retired.' });
    await t.app.close();
  });

  it('its exact version still loads (run history pins it), and it stays out of the catalog', async () => {
    const { t, get } = await signedIn();
    const exact = await get('/api/definitions/page/identity.old-users?version=1.1.0');
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ id: 'identity.old-users', status: 'retired', version: '1.1.0' });
    const list = await get('/api/definitions?kind=page');
    expect(list.json().items.map((i: { key: string }) => i.key)).not.toContain('identity.old-users');
    await t.app.close();
  });

  it('a retired page someone may not open is refused for the role, before its note is shown', async () => {
    const { t, get } = await signedIn('Portal.Reader');
    const res = await get('/api/definitions/page/identity.old-admins');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).not.toMatch(/Replaced by/);
    await t.app.close();
  });

  it("the page's data is refused the same way, with the note", async () => {
    const { t, post } = await signedIn();
    const res = await post('/api/datasources/execute-many', { page: 'identity.old-users' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'definition_retired',
      message: expect.stringContaining('Replaced by Users (identity.users)'),
    });
    await t.app.close();
  });

  it('an unknown key is a 404 whose hint is for the person, not a CLI command', async () => {
    const { t, get } = await signedIn();
    for (const url of ['/api/definitions/page/nope.nothing', '/api/definitions/report/nope.nothing']) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      const error = res.json().error;
      expect(error).toMatchObject({
        code: 'definition_not_found',
        hint: 'Check the address, or open it from the navigation.',
      });
      expect(JSON.stringify(error)).not.toMatch(/adminforge/i);
    }
    await t.app.close();
  });
});
