import { ApiErrorBody } from '@adminforge/schemas';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { makeApp, mockConfig, mockLogin } from './helpers';

// F-13 through the real app: the error bodies a person can meet carry a plain message, a hint where they can act,
// the code and the reference — including the ones Fastify raises itself (an oversized or unreadable body).
let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

const plain = (res: { json(): unknown }) => {
  const { error } = ApiErrorBody.parse(res.json());
  expect(error.correlationId).toEqual(expect.any(String));
  expect(error.hint, `${error.code} has a hint`).toBeTruthy();
  expect(`${error.message} ${error.hint}`).not.toMatch(
    /FST_|ctp_|content-type|Invalid option|Invalid input|No route for|"\|"/i,
  );
  return error;
};

describe('error bodies people meet', () => {
  it('an oversized body is 413 body_too_large, not Fastify’s code', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ recents: ['x'.repeat(300 * 1024)] }),
    });
    expect(res.statusCode).toBe(413);
    expect(plain(res)).toMatchObject({ code: 'body_too_large' });
    await t.app.close();
  });

  it('a body that isn’t JSON is a plain invalid_request', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf, 'content-type': 'application/json' },
      payload: '{"theme": ',
    });
    expect(res.statusCode).toBe(400);
    expect(plain(res)).toMatchObject({ code: 'invalid_request' });
    await t.app.close();
  });

  it('an unknown /api address is not_found with a hint, without echoing the address', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/nothing-here?q=secret', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    const error = plain(res);
    expect(error).toMatchObject({ code: 'not_found', message: 'AdminForge has nothing at this address.' });
    expect(JSON.stringify(error)).not.toContain('secret');
    await t.app.close();
  });

  it('a run you can’t see, a stale list position and a bad field all say what to do', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    const run = await t.app.inject({
      method: 'GET',
      url: '/api/runs/00000000-0000-4000-8000-000000000001',
      headers: { cookie },
    });
    expect(run.statusCode).toBe(404);
    expect(plain(run).code).toBe('run_not_found');

    const cursor = await t.app.inject({ method: 'GET', url: '/api/runs?cursor=nope', headers: { cookie } });
    expect(cursor.statusCode).toBe(400);
    expect(plain(cursor).code).toBe('invalid_request');

    const field = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { theme: 'neon' },
    });
    expect(field.statusCode).toBe(400);
    expect(plain(field).message).toMatch(/^The request isn’t valid: theme must be one of /);
    await t.app.close();
  });

  it('a page datasource that doesn’t exist, and a forged paging cursor, say to reload', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const post = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: '/api/datasources/execute',
        headers: { cookie, 'x-adminforge-csrf': csrf },
        payload,
      });
    const missing = await post({ page: 'identity.users', datasource: 'nope', params: {} });
    expect(missing.statusCode).toBe(404);
    expect(plain(missing)).toMatchObject({
      code: 'datasource_not_found',
      hint: expect.stringMatching(/Reload/),
    });

    const forged = await post({
      page: 'identity.users',
      datasource: 'users',
      params: {},
      cursor: 'forged.cursor',
    });
    expect(forged.statusCode).toBe(400);
    expect(plain(forged)).toMatchObject({ code: 'invalid_cursor', hint: expect.stringMatching(/Reload/) });
    await t.app.close();
  });
});
