import { ApiErrorBody } from '@adminforge/schemas';
import { makeApp, mockConfig, mockLogin } from './helpers';
import { AVERY, BLAKE, READER, schedulesApp } from './schedules-helpers';

/** Emergency stop (ENG-08): pause/resume all changes or all automation from the portal, audited. */
describe('emergency stop routes', () => {
  let t: Awaited<ReturnType<typeof schedulesApp>>;
  beforeEach(async () => {
    t = await schedulesApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const put = (headers: Record<string, string>, payload: unknown) =>
    t.app.inject({ method: 'PUT', url: '/api/admin/emergency', headers, payload: payload as never });

  it('everyone signed in reads the state (for the banner) and what they may do', async () => {
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get('/api/emergency');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      writes: { paused: false, reason: null, by: null, at: null },
      automation: { paused: false, reason: null, by: null, at: null },
      canPause: false,
      canResume: false,
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/emergency' })).statusCode).toBe(401);
  });

  it('a Playbook Approver can pause (with a reason) but not resume; audited with actor and reason', async () => {
    const approver = await t.login(AVERY, ['Portal.Reader', 'Playbook.Approver']);
    expect((await approver.get('/api/emergency')).json()).toMatchObject({ canPause: true, canResume: false });

    const noReason = await put(approver.headers, { target: 'writes', paused: true, reason: '  ' });
    expect(noReason.statusCode).toBe(400);
    expect(ApiErrorBody.parse(noReason.json()).error).toMatchObject({
      code: 'invalid_request',
      hint: expect.stringContaining('audit log'),
    });

    const paused = await put(approver.headers, {
      target: 'writes',
      paused: true,
      reason: 'Suspected compromised operator account',
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      writes: {
        paused: true,
        reason: 'Suspected compromised operator account',
        by: AVERY.upn,
        at: t.clock.now().toISOString(),
      },
      automation: { paused: false },
    });
    const audit = t.audit.rows.find((r) => r.action === 'emergency.paused')!;
    expect(audit).toMatchObject({
      actorOid: AVERY.oid,
      actorUpn: AVERY.upn,
      targetType: 'settings',
      targetId: 'emergency.writes',
      result: 'success',
    });
    expect(audit.details).toMatchObject({
      target: 'writes',
      reason: 'Suspected compromised operator account',
    });

    const resume = await put(approver.headers, { target: 'writes', paused: false });
    expect(resume.statusCode).toBe(403);
    expect(ApiErrorBody.parse(resume.json()).error).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('Portal.Admin'),
    });

    // Pausing again changes nothing and isn't audited twice.
    await put(approver.headers, { target: 'writes', paused: true, reason: 'again' });
    expect(t.audit.rows.filter((r) => r.action === 'emergency.paused')).toHaveLength(1);
  });

  it('only Portal.Admin resumes; readers and operators can do neither', async () => {
    const operator = await t.login(BLAKE, ['Portal.Reader', 'Portal.Operator']);
    const refused = await put(operator.headers, { target: 'automation', paused: true, reason: 'test' });
    expect(refused.statusCode).toBe(403);
    expect(ApiErrorBody.parse(refused.json()).error.message).toMatch(/Portal\.Admin or Playbook\.Approver/);

    const admin = await t.login(AVERY, ['Portal.Reader', 'Portal.Admin']);
    expect(
      (await put(admin.headers, { target: 'automation', paused: true, reason: 'Tenant migration' })).json(),
    ).toMatchObject({ automation: { paused: true, by: AVERY.upn } });
    t.clock.t += 60_000;
    const resumed = await put(admin.headers, { target: 'automation', paused: false, reason: 'Done' });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      automation: { paused: false, reason: null, by: AVERY.upn },
      canPause: true,
      canResume: true,
    });
    const audit = t.audit.rows.find((r) => r.action === 'emergency.resumed')!;
    expect(audit).toMatchObject({ actorOid: AVERY.oid, targetId: 'emergency.automation' });
    expect(audit.details).toMatchObject({
      target: 'automation',
      reason: 'Done',
      pausedReason: 'Tenant migration',
    });
  });

  it('needs the CSRF header and a well-formed body', async () => {
    const admin = await t.login(AVERY, ['Portal.Reader', 'Portal.Admin']);
    const noCsrf = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/emergency',
      headers: { cookie: admin.headers.cookie },
      payload: { target: 'writes', paused: true, reason: 'x y z' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(ApiErrorBody.parse(noCsrf.json()).error.code).toBe('csrf');
    expect(
      (await put(admin.headers, { target: 'everything', paused: true, reason: 'x y z' })).statusCode,
    ).toBe(400);
    expect(
      (await put(admin.headers, { target: 'writes', paused: true, reason: 'x y z', extra: 1 })).statusCode,
    ).toBe(400);
    expect(t.audit.rows.some((r) => r.action.startsWith('emergency.'))).toBe(false);
  });
});

describe('emergency stop reaches the executor', () => {
  it('after pausing changes, declared writes are refused (writes_paused) and reads still work', async () => {
    const t = await makeApp(mockConfig());
    try {
      const { cookie, csrf } = await mockLogin(t.app);
      const headers = { cookie, 'x-adminforge-csrf': csrf };
      const pause = await t.app.inject({
        method: 'PUT',
        url: '/api/admin/emergency',
        headers,
        payload: { target: 'writes', paused: true, reason: 'Incident 4711' },
      });
      expect(pause.statusCode).toBe(200);
      const write = {
        service: 'graph' as const,
        method: 'PATCH',
        path: '/users/00000000-0000-4000-8000-000000000102',
        body: { jobTitle: 'x' },
        declaredWrite: true,
      };
      await expect(
        t.app.ctx.outbound.execute({ kind: 'automation', mode: 'write' }, write),
      ).rejects.toMatchObject({
        code: 'writes_paused',
      });
      const read = await t.app.ctx.outbound.execute(
        { kind: 'automation', mode: 'read' },
        { service: 'graph', method: 'GET', path: '/organization' },
      );
      expect(read.status).toBe(200);

      await t.app.inject({
        method: 'PUT',
        url: '/api/admin/emergency',
        headers,
        payload: { target: 'writes', paused: false },
      });
      await expect(
        t.app.ctx.outbound.execute({ kind: 'automation', mode: 'write' }, write),
      ).rejects.not.toMatchObject({ code: 'writes_paused' });
    } finally {
      await t.app.close();
    }
  });
});
