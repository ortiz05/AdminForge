import { DENIAL_AUDIT_WINDOW_MS } from '@adminforge/api/src/errors';
import { makeApp, MINUTE, mockConfig, mockLogin } from './helpers';

// APP-04 / ENG-09: security-relevant refusals are audited (request.denied), rate-limited per session and code, without
// request bodies or query values; and request log lines say who (the oid) once the session is known.
const denied = (t: Awaited<ReturnType<typeof makeApp>>) =>
  t.audit.rows.filter((r) => r.action === 'request.denied');

describe('denied requests are audited (APP-04)', () => {
  it('a CSRF failure is recorded with the route pattern, code and status — nothing from the request itself', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, me } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs?secretQuery=alice%40example.com',
      headers: { cookie, 'x-adminforge-csrf': 'wrong' },
      payload: { recents: ['bob@example.com'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
    const [row] = denied(t);
    expect(row).toMatchObject({
      actorOid: me.user.oid,
      result: 'denied',
      targetType: 'route',
      targetId: 'PUT /api/me/prefs',
      correlationId: res.headers['x-correlation-id'],
      details: { code: 'csrf', status: 403 },
    });
    expect(JSON.stringify(row)).not.toMatch(/alice|bob|secretQuery/);
    await t.app.close();
  });

  it('at most one event per session and code a minute; the next one says how many were not recorded', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    const bad = () =>
      t.app.inject({
        method: 'PUT',
        url: '/api/me/prefs',
        headers: { cookie, 'x-adminforge-csrf': 'x' },
        payload: {},
      });
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(403);
    expect(denied(t)).toHaveLength(1);
    expect(denied(t)[0]!.details).toEqual({ code: 'csrf', status: 403 });

    // Another code in the same minute is its own event.
    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': (await mockCsrf(t, cookie))! },
      payload: { roles: ['Playbook.Author'] },
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } })).statusCode).toBe(
      403,
    );
    expect(denied(t).map((r) => (r.details as { code: string }).code)).toEqual(['csrf', 'forbidden']);

    t.clock.advance(DENIAL_AUDIT_WINDOW_MS);
    await bad();
    expect(denied(t)).toHaveLength(3);
    expect(denied(t).at(-1)!.details).toEqual({ code: 'csrf', status: 403, suppressed: 4 });
    expect((await t.audit.verify()).ok).toBe(true);
    await t.app.close();
  });

  it('ordinary mistakes (validation, not found) are not audited', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { unknownKey: 1 },
    });
    await t.app.inject({ method: 'GET', url: '/api/runs/does-not-exist', headers: { cookie } });
    t.clock.advance(MINUTE);
    expect(denied(t)).toHaveLength(0);
    await t.app.close();
  });
});

describe('request logs say who (ENG-09)', () => {
  it('binds the session’s oid (never the UPN) to the request logger', async () => {
    const t = await makeApp(mockConfig());
    const bindings: object[] = [];
    // Record what the session hook binds (the test logger is silent).
    t.app.addHook('onRequest', async (request) => {
      const log = request.log;
      request.log = Object.assign(Object.create(log) as typeof log, {
        child: (b: object) => {
          bindings.push(b);
          return log;
        },
      });
    });
    const { cookie, me } = await mockLogin(t.app);
    bindings.length = 0;
    await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(bindings).toEqual([{ oid: me.user.oid }]);
    expect(JSON.stringify(bindings)).not.toContain(me.user.upn);
    await t.app.close();
  });
});

async function mockCsrf(t: Awaited<ReturnType<typeof makeApp>>, cookie: string) {
  const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return res.json().csrf as string | undefined;
}
