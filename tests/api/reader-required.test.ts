import { READER_EXEMPT } from '@adminforge/api/src/app';
import { ApiErrorBody } from '@adminforge/schemas';
import { makeApp, mockConfig, mockLogin, type TestApp } from './helpers';

// IAM-06: every /api route needs Portal.Reader ("everyone needs this", docs/access.md) except the few the shell needs
// to load and explain the missing role: who am I, preferences, appearance and the event stream.
async function signedInAs(roles: string[]) {
  const t = await makeApp(mockConfig());
  const { cookie, csrf } = await mockLogin(t.app);
  const res = await t.app.inject({
    method: 'POST',
    url: '/auth/mock/state',
    headers: { cookie, 'x-adminforge-csrf': csrf },
    payload: { roles },
  });
  expect(res.statusCode).toBe(200);
  return { ...t, cookie, csrf, headers: { cookie, 'x-adminforge-csrf': csrf } };
}

describe('Portal.Reader is required across /api (IAM-06)', () => {
  let t: TestApp & { cookie: string; headers: Record<string, string> };
  afterEach(async () => {
    await t.app.close();
  });

  it.each([
    ['GET', '/api/search?q=avery'],
    ['GET', '/api/overview'],
    ['GET', '/api/me/capabilities'],
    ['GET', '/api/nav'],
    ['GET', '/api/runs'],
    ['GET', '/api/approvals'],
    ['POST', '/api/runs'],
    ['POST', '/api/datasources/execute'],
  ])('a Playbook.Author-only session gets a friendly 403 for %s %s', async (method, url) => {
    t = await signedInAs(['Playbook.Author']);
    const res = await t.app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: t.headers,
      ...(method === 'POST' ? { payload: { playbook: 'x', dryRun: true } } : {}),
    });
    expect(res.statusCode).toBe(403);
    const error = ApiErrorBody.parse(res.json()).error;
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('Using AdminForge needs the Portal.Reader role.');
    expect(error.hint).toMatch(/AdminForge Reader group \(SG-AdminForge-…-Portal\.Reader\)/);
    expect(error.correlationId).toBeTruthy();
  });

  it('approver-only and admin-only sessions are refused too (both need Reader as well)', async () => {
    t = await signedInAs(['Playbook.Approver', 'Portal.Admin']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/approvals', headers: t.headers })).statusCode,
    ).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/audit', headers: t.headers })).statusCode).toBe(
      403,
    );
  });

  it('the shell still loads without Reader: /api/me, preferences and appearance', async () => {
    t = await signedInAs(['Playbook.Author']);
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().roles).toEqual(['Playbook.Author']);
    const prefs = await t.app.inject({
      method: 'PUT',
      url: '/api/me/prefs',
      headers: t.headers,
      payload: { recents: [] },
    });
    expect(prefs.statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/appearance.css', headers: t.headers })).statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'HEAD', url: '/api/appearance.css', headers: t.headers })).statusCode,
    ).toBe(200);
  });

  it('every exemption names a registered route, and the emergency banner state loads without Reader', async () => {
    t = await signedInAs(['Playbook.Author']);
    await t.app.ready();
    for (const entry of READER_EXEMPT) {
      const [method, url] = entry.split(' ') as ['GET' | 'PUT', string];
      expect(t.app.hasRoute({ method, url }), entry).toBe(true);
    }
    expect(READER_EXEMPT.size).toBe(5);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/emergency', headers: t.headers })).statusCode,
    ).toBe(200);
  });

  it('the event stream opens without Reader', async () => {
    t = await signedInAs(['Playbook.Author']);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${address}/api/events`, { headers: { cookie: t.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  });

  it('a Reader keeps working, and the refusal is audited as request.denied', async () => {
    t = await signedInAs(['Playbook.Author']);
    await t.app.inject({ method: 'GET', url: '/api/search?q=avery', headers: t.headers });
    expect(t.audit.rows.at(-1)).toMatchObject({
      action: 'request.denied',
      result: 'denied',
      targetType: 'route',
      targetId: 'GET /api/search',
      details: { code: 'forbidden', status: 403 },
    });
    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: t.headers,
      payload: { roles: ['Portal.Reader'] },
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/nav', headers: t.headers })).statusCode).toBe(200);
  });
});
