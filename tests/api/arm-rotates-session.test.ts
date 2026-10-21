import {
  APPROVER,
  armMock,
  gate,
  hashOf,
  OPERATOR,
  openStream,
  respond,
  rotationDefinitions,
  TAP,
  USER,
  waitFor,
} from './arm-rotate-helpers';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  MINUTE,
  mockConfig,
  mockLogin,
  orgResponse,
  setCookieHeader,
} from './helpers';
import { RoleCheck } from '@adminforge/api/src/auth/session-plugin';
import { MemorySessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import type { MemoryRunRepository } from '@adminforge/api/src/runs';
import { AVERY, BLAKE, FakeExecutor, runsApp } from './runs-helpers';

// S-08: arming gives the session a new id. An id that existed before the step-up — copied or planted while the session
// was read-only — must never carry write access; everything kept under the old id moves with the session in one step,
// and the old id stops working at once. These run on the in-memory stores; arm-rotates-session-db.test.ts on SQLite.

describe('arming rotates the session id (memory stores)', () => {
  it('the old cookie is refused at once (without clearing the new one); the new one is armed with a new CSRF token', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    const armed = await armMock(t.app, { cookie, 'x-adminforge-csrf': csrf });

    expect(armed.cookie).toMatch(/^adminforge-dev=[A-Za-z0-9_-]{43}$/);
    expect(armed.cookie).not.toBe(cookie);
    expect(setCookieHeader(armed.res)).toMatch(/HttpOnly/);
    expect([...t.sessions.rows.keys()]).toEqual([hashOf(armed.cookie)]);

    const old = await getMe(t.app, cookie);
    expect(old.res.statusCode).toBe(401);
    expect(old.res.json().error.code).toBe('unauthenticated');
    // A request still carrying the old id doesn't clear the cookie: the browser already holds the new one (same name).
    expect(setCookieHeader(old.res)).toBeUndefined();

    const { me } = await getMe(t.app, armed.cookie);
    expect(me).toMatchObject({ mode: 'armed', armedUntil: new Date(t.clock.t + 30 * MINUTE).toISOString() });
    expect(me!.csrf).not.toBe(csrf);
    // The CSRF token is the session's: the old one went with the old id.
    const stale = await t.app.inject({
      method: 'POST',
      url: '/auth/disarm',
      headers: { cookie: armed.cookie, 'x-adminforge-csrf': csrf },
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('csrf');

    // Audited as rotated, under the new hash; no session id in clear anywhere in the log.
    const event = t.audit.rows.find((r) => r.action === 'session.armed')!;
    expect(event).toMatchObject({ result: 'success', sessionHash: hashOf(armed.cookie) });
    expect(event.details).toMatchObject({ sessionRotated: true });
    const log = JSON.stringify(t.audit.rows);
    for (const c of [cookie, armed.cookie]) expect(log).not.toContain(c.split('=')[1]);

    // Once the browser has certainly moved on, an unknown id is cleared as usual.
    t.clock.advance(2 * MINUTE);
    const later = await getMe(t.app, cookie);
    expect(later.res.statusCode).toBe(401);
    expect(setCookieHeader(later.res)).toMatch(/^adminforge-dev=;/);
    await t.app.close();
  });

  it('extend and disarm keep the session id', async () => {
    const t = await makeApp(mockConfig());
    const login = await mockLogin(t.app);
    const armed = await armMock(t.app, { cookie: login.cookie, 'x-adminforge-csrf': login.csrf });
    const extend = await t.app.inject({
      method: 'POST',
      url: '/auth/arm/extend',
      headers: armed.headers,
      payload: {},
    });
    expect(extend.statusCode).toBe(200);
    expect(setCookieHeader(extend)).toBeUndefined();
    const disarm = await t.app.inject({ method: 'POST', url: '/auth/disarm', headers: armed.headers });
    expect(disarm.statusCode).toBe(200);
    expect(setCookieHeader(disarm)).toBeUndefined();
    expect((await getMe(t.app, armed.cookie)).me).toMatchObject({ mode: 'read', csrf: armed.csrf });
    expect([...t.sessions.rows.keys()]).toEqual([hashOf(armed.cookie)]);
    await t.app.close();
  });

  it('the token partitions move, sealed again under the new id (the partition key is their associated data)', async () => {
    const t = await makeApp(mockConfig());
    const { cookie, csrf } = await mockLogin(t.app);
    const from = hashOf(cookie);
    await t.tokenCache.set(`read:${from}`, '{"account":"read"}');
    await t.tokenCache.set(`write:${from}`, '{"account":"write"}');
    const sealedBefore = t.tokenBlobs.rows.get(`read:${from}`);
    const armed = await armMock(t.app, { cookie, 'x-adminforge-csrf': csrf });
    const to = hashOf(armed.cookie);
    expect([...t.tokenBlobs.rows.keys()].sort()).toEqual([`read:${to}`, `write:${to}`]);
    expect(t.tokenBlobs.rows.get(`read:${to}`)).not.toBe(sealedBefore);
    expect(await t.tokenCache.get(`read:${to}`)).toBe('{"account":"read"}');
    expect(await t.tokenCache.get(`write:${to}`)).toBe('{"account":"write"}');
    // A moved blob opens only under its new key: copied back to the old one, it doesn't.
    t.tokenBlobs.rows.set(`read:${from}`, t.tokenBlobs.rows.get(`read:${to}`)!);
    expect(await t.tokenCache.get(`read:${from}`)).toBe('');
    await t.app.close();
  });

  it('Entra: the Write app redeems into the new id’s partition; a refused arm keeps the id; pending round trips move', async () => {
    const auth = new FakeAuthClient();
    const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const signedIn = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${new URL(login.headers.location as string).searchParams.get('state')}`,
      headers: { cookie: bindingCookie(login)! },
    });
    const cookie = cookieFrom(signedIn)!;
    const from = hashOf(cookie);
    const csrf = (await getMe(t.app, cookie)).me!.csrf;
    const start = async (c: string, token: string) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/auth/arm',
        headers: { cookie: c, 'x-adminforge-csrf': token },
        payload: { minutes: 30, reason: 'Disable a test user' },
      });
      return { state: new URL(res.json().redirect).searchParams.get('state')!, pre: bindingCookie(res)! };
    };
    const callback = (c: string, s: { state: string; pre: string }, code = 'write-code') =>
      t.app.inject({
        method: 'GET',
        url: `/auth/arm/callback?code=${code}&state=${s.state}`,
        headers: { cookie: `${c}; ${s.pre}` },
      });

    // Verified with another account: refused, the session keeps its id, the new id's Write partition is gone.
    auth.claims = (kind) => (kind === 'write' ? { oid: '55555555-6666-4777-8888-999999999999' } : {});
    const refused = await callback(cookie, await start(cookie, csrf));
    expect(refused.statusCode).toBe(403);
    expect(cookieFrom(refused)).toBeUndefined();
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
    expect([...t.tokenBlobs.rows.keys()]).toEqual([`read:${from}`]);
    auth.claims = () => ({});

    // Another tab started arming too; this one finishes first.
    const otherTab = await start(cookie, csrf);
    const ok = await callback(cookie, await start(cookie, csrf));
    expect(ok.statusCode).toBe(302);
    const next = cookieFrom(ok)!;
    const to = hashOf(next);
    expect(auth.redeems.at(-1)).toMatchObject({ kind: 'write', partitionKey: `write:${to}` });
    expect([...t.tokenBlobs.rows.keys()].sort()).toEqual([`read:${to}`, `write:${to}`]);
    expect(await t.tokenCache.get(`read:${to}`)).toBe('{"account":"redeemed:good-code"}');
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(401);
    expect((await getMe(t.app, next)).me!.mode).toBe('armed');
    expect(t.audit.rows.filter((r) => r.action === 'session.armed').map((r) => r.details)).toMatchObject([
      { error: 'user_mismatch' },
      { sessionRotated: true, stepUp: 'freshSignIn' },
    ]);

    // The other tab's round trip moved with the session: it completes with the new cookie and rotates again; the
    // Write partition of that arm replaces the earlier one.
    expect(t.preauth.rows.get(otherTab.state)!.sessionIdHash).toBe(to);
    const again = await callback(next, otherTab, 'second-write-code');
    expect(again.statusCode).toBe(302);
    const third = hashOf(cookieFrom(again)!);
    expect(third).not.toBe(to);
    expect([...t.tokenBlobs.rows.keys()].sort()).toEqual([`read:${third}`, `write:${third}`]);
    expect(await t.tokenCache.get(`write:${third}`)).toBe('{"account":"redeemed:second-write-code"}');
    await t.app.close();
  });
});

describe('what the session acts through moves with it (runs, approvals, show-once secrets, streams)', () => {
  it('an in-flight run keeps working: its next reads act through the new id', async () => {
    const first = gate();
    const outbound = new FakeExecutor(respond({ '/users/first': first.opened }));
    const t = await runsApp({ config: mockConfig(), definitions: rotationDefinitions(), outbound });
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.two-reads', inputs: { userId: USER } })
    ).json();
    await waitFor(() => outbound.calls.length === 1);

    const armed = await armMock(t.app, avery.headers);
    // Bound while the session was read-only: it reads on, and would ask before writing (prearm).
    expect((t.repository as MemoryRunRepository).runs.get(runId)!.sessionHash).toBe(
      `prearm:${hashOf(armed.cookie)}`,
    );
    first.open();
    await t.drain();

    const detail = await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers });
    expect(detail.json().run.status).toBe('succeeded');
    expect(outbound.calls.map((c) => [c.call.path, c.user])).toEqual([
      ['/users/first', AVERY.upn],
      ['/groups/second', AVERY.upn],
    ]);
    expect((await avery.get(`/api/runs/${runId}`)).statusCode).toBe(401);
    await t.close();
  });

  it('a run started while read-only reads on after the arm, but writes only once its person resumes it', async () => {
    const first = gate();
    const outbound = new FakeExecutor(respond({ '/users/first': first.opened }));
    const t = await runsApp({ config: mockConfig(), definitions: rotationDefinitions(), outbound });
    // Started with the read-only id — by the person, or by whoever copied the id before they armed.
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.read-then-write', inputs: { userId: USER } })
    ).json();
    await waitFor(() => outbound.calls.length === 1);
    const armed = await armMock(t.app, avery.headers);
    first.open();
    await t.drain();

    const parked = (
      await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers })
    ).json();
    expect(parked.run).toMatchObject({ status: 'awaiting_arm', waiting: { kind: 'arm', stepId: 'disable' } });
    expect(outbound.calls.map((c) => c.call.method)).toEqual(['GET']);
    // The old id can't let it go on; the person, armed, resumes it — and only then does it write.
    expect((await avery.post(`/api/runs/${runId}/resume`)).statusCode).toBe(401);
    const resumed = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      headers: armed.headers,
    });
    expect(resumed.statusCode).toBe(202);
    await t.drain();
    const done = (
      await t.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: armed.headers })
    ).json();
    expect(done.run.status).toBe('succeeded');
    expect(outbound.calls.map((c) => [c.call.method, c.user])).toEqual([
      ['GET', AVERY.upn],
      ['PATCH', AVERY.upn],
    ]);
    expect((t.repository as MemoryRunRepository).runs.get(runId)!.sessionHash).toBe(hashOf(armed.cookie));
    await t.close();
  });

  it('an approver’s decision moves with their session: the steps after the approval still act as them', async () => {
    const look = gate();
    const outbound = new FakeExecutor(respond({ '/users/look': look.opened }));
    const t = await runsApp({ config: mockConfig(), definitions: rotationDefinitions(), outbound });
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.tap-approved', inputs: { userId: USER } })
    ).json();
    await t.drain();
    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(
      200,
    );
    await waitFor(() => outbound.calls.length === 1);

    // Blake arms again (a new window) while the run reads as him.
    const rearmed = await armMock(t.app, blake.headers);
    const [task] = [...(t.repository as MemoryRunRepository).tasks.values()];
    expect(task!.decisions.map((d) => [d.oid, d.sessionHash])).toEqual([[BLAKE.oid, hashOf(rearmed.cookie)]]);
    look.open();
    await t.drain();

    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect(outbound.calls.map((c) => [c.call.method, c.user])).toEqual([
      ['GET', BLAKE.upn],
      ['POST', BLAKE.upn],
    ]);
    await t.close();
  });

  it('a held show-once secret moves to the new id: only the new cookie can fetch it', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: rotationDefinitions(),
      outbound: new FakeExecutor(respond()),
    });
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.tap', inputs: { userId: USER } })
    ).json();
    await t.drain();
    await waitFor(() => t.runs.secrets.heldCount === 1);

    const armed = await armMock(t.app, avery.headers);
    expect((await avery.get(`/api/runs/${runId}/secret/create`)).statusCode).toBe(401);
    const got = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/secret/create`,
      headers: armed.headers,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().values).toEqual({ temporaryAccessPass: TAP });
    await t.close();
  });

  it('open streams of the old id end quietly (no session.ended): the browser reconnects with the new cookie', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: rotationDefinitions(),
      outbound: new FakeExecutor(respond()),
    });
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.tap-approved', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const events = await openStream(`${address}/api/events`, avery.headers.cookie);
    const run = await openStream(`${address}/api/runs/${runId}/events`, avery.headers.cookie);
    await events.until('event: ready');
    await run.until('"status":"awaiting_approval"');

    const armed = await armMock(t.app, avery.headers);
    await events.until(null);
    await run.until(null);
    for (const s of [events, run]) {
      expect(s.state.text).not.toContain('session.ended');
      expect(s.state.text).not.toContain('event: end');
    }

    // The reconnect carries the new cookie; one with the old id is refused.
    const back = await openStream(`${address}/api/events`, armed.cookie);
    await back.until('event: ready');
    expect(back.state.text).toContain('"mode":"armed"');
    expect((await openStream(`${address}/api/events`, avery.headers.cookie)).state.status).toBe(401);
    await back.close();

    // A secret the run produces now goes to the new id, held for its fetch (no stream of it is open).
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(
      200,
    );
    await t.drain();
    await waitFor(() => t.runs.secrets.heldCount === 1);
    const got = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/secret/create`,
      headers: armed.headers,
    });
    expect(got.json().values).toEqual({ temporaryAccessPass: TAP });
    await t.close();
  });
});

/** Signs in through the fake Entra flow and starts arming: the callback's state and the cookies the browser sends. */
async function entraArmStart(
  t: Awaited<ReturnType<typeof makeApp>>,
  beforeArm: (cookie: string) => Promise<void> = async () => undefined,
) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const signedIn = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${new URL(login.headers.location as string).searchParams.get('state')}`,
    headers: { cookie: bindingCookie(login)! },
  });
  const cookie = cookieFrom(signedIn) ?? cookieFrom(signedIn, '__Host-adminforge')!;
  await beforeArm(cookie);
  const csrf = (await getMe(t.app, cookie)).me!.csrf;
  const started = await t.app.inject({
    method: 'POST',
    url: '/auth/arm',
    headers: { cookie, 'x-adminforge-csrf': csrf },
    payload: { minutes: 30, reason: 'Disable a test user' },
  });
  const state = new URL(started.json().redirect).searchParams.get('state');
  return {
    cookie,
    callback: () =>
      t.app.inject({
        method: 'GET',
        url: `/auth/arm/callback?code=write-code&state=${state}`,
        headers: { cookie: `${cookie}; ${bindingCookie(started)}` },
      }),
  };
}

describe('around the rotation', () => {
  it('in production the new cookie is __Host-, Secure, HttpOnly, SameSite=Lax, and ends with the session', async () => {
    const auth = new FakeAuthClient();
    const t = await makeApp(
      entraConfig({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://adminforge.example.com',
        LOG_LEVEL: 'silent',
      }),
      { auth, fetch: async () => orgResponse() },
    );
    // Two hours of work (never idle for an hour) before arming.
    const { callback } = await entraArmStart(t, async (cookie) => {
      for (let i = 0; i < 4; i++) {
        t.clock.advance(30 * MINUTE);
        expect((await getMe(t.app, cookie)).res.statusCode).toBe(200);
      }
    });
    const cb = await callback();
    expect(cb.statusCode).toBe(302);
    const set = setCookieHeader(cb, '__Host-adminforge')!;
    expect(set).toMatch(/^__Host-adminforge=[A-Za-z0-9_-]{43};/);
    for (const flag of [/Secure/, /HttpOnly/, /SameSite=Lax/, /Path=\//]) expect(set).toMatch(flag);
    expect(set).not.toMatch(/Domain=/);
    // 12-hour sessions, signed in two hours ago: the cookie lasts as long as the session does, not 12 more hours.
    expect(set).toMatch(/Max-Age=36000(;|$)/);
    await t.app.close();
  });

  it('signed out while verifying: nothing is armed, the Write tokens just redeemed go, the failure is audited', async () => {
    const auth = new FakeAuthClient();
    const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
    const { cookie, callback } = await entraArmStart(t);
    // Sign-out in another tab lands while Microsoft redeems the Write app's code.
    const redeem = auth.redeem.bind(auth);
    auth.redeem = async (input) => {
      const result = await redeem(input);
      if (input.kind === 'write') await t.sessions.delete(hashOf(cookie));
      return result;
    };
    const cb = await callback();
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error.code).toBe('unauthenticated');
    expect(cookieFrom(cb)).toBeUndefined();
    expect(auth.forgets).toContainEqual({ kind: 'write', partitionKey: auth.redeems.at(-1)!.partitionKey });
    expect([...t.tokenBlobs.rows.keys()].filter((k) => k.startsWith('write:'))).toEqual([]);
    expect(t.sessions.rows.size).toBe(0);
    expect(t.audit.rows.at(-1)).toMatchObject({
      action: 'session.armed',
      result: 'failure',
      details: { error: 'unauthenticated' },
    });
    await t.app.close();
  });

  it('a role re-check that lost its session to the rotation ends nothing and audits no revocation', async () => {
    const auth = new FakeAuthClient();
    const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
    const { cookie, callback } = await entraArmStart(t);
    const before: SessionRecord = structuredClone(t.sessions.rows.get(hashOf(cookie))!);
    const next = cookieFrom(await callback())!;
    // A request (or run step) that read the old record re-checks its roles after the commit: the old id's token
    // partition moved, so Entra looks like it refused.
    t.clock.advance(6 * MINUTE);
    auth.refreshImpl = async () => {
      throw new ReauthRequired('read');
    };
    const check = new RoleCheck(t.app.ctx);
    expect(await check.check(before, t.clock.now(), { correlationId: 'c-1' })).toBeNull();
    expect(t.audit.rows.some((r) => r.action === 'session.access_revoked')).toBe(false);
    expect(t.sessions.rows.has(hashOf(next))).toBe(true);
    await t.app.close();
  });

  it('a mover that is not synchronous is refused: it would write outside the transaction', async () => {
    const sessions = new MemorySessionStore();
    const now = new Date('2026-10-15T12:00:00.000Z');
    await sessions.create({
      idHash: 'old',
      userOid: AVERY.oid,
      upn: AVERY.upn,
      displayName: AVERY.upn,
      tenantId: 't',
      tenantName: 'Example Org',
      tenantDomain: 'example.com',
      roles: OPERATOR,
      csrf: 'c',
      readAccountId: null,
      writeAccountId: null,
      writeExpiresAt: null,
      writeExtended: false,
      writeReason: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      ip: null,
      userAgent: null,
    });
    sessions.onRotate({ moveSessionTx: (async () => undefined) as never });
    await expect(sessions.rotate({ from: 'old', to: 'new', patch: {}, now })).rejects.toThrow(/synchronous/);
    expect([...sessions.rows.keys()]).toEqual(['old']);
  });
});
