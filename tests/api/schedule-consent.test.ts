import { grantPartition } from '@adminforge/api/src/schedules/grants';
import { Schedule } from '@adminforge/schemas';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  makeApp,
  orgResponse,
  USER_OID,
  type TestApp,
} from './helpers';

// A schedule that runs with its creator's own access (ADR-014) is granted once, by its creator, through a fresh
// sign-in to the Read app: POST /auth/schedule-consent → Entra → /auth/callback. The refresh token lands in that
// schedule's own token-cache partition, the grant is recorded and audited, and the person's own session is untouched.

type Setup = TestApp & { auth: FakeAuthClient };
const OTHER = '00000000-0000-4000-8000-0000000000b2';

async function setup(): Promise<Setup> {
  const auth = new FakeAuthClient();
  const t = await makeApp(entraConfig(), { auth, fetch: async () => orgResponse() });
  return { ...t, auth };
}

async function signIn(t: Setup) {
  const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
  const state = new URL(login.headers.location as string).searchParams.get('state');
  const cb = await t.app.inject({
    method: 'GET',
    url: `/auth/callback?code=good-code&state=${state}`,
    headers: { cookie: bindingCookie(login)! },
  });
  const cookie = cookieFrom(cb)!;
  const { me } = await getMe(t.app, cookie);
  return { cookie, csrf: me!.csrf };
}

async function addSchedule(t: Setup, key: string, o: { createdBy?: string; identity?: unknown } = {}) {
  const def = Schedule.parse({
    kind: 'schedule',
    id: key,
    version: '1.0.0',
    title: 'Inactive users, weekly',
    owner: 'avery@example.com',
    cron: '0 6 * * 1',
    identity: o.identity ?? { user: 'creator' },
    job: { kind: 'report', ref: 'identity.inactive-users', delivery: [{ type: 'file', format: 'csv' }] },
    requires: { portalRoles: ['Portal.Operator'] },
  });
  return (await t.app.schedules.store.insertSchedule({
    key,
    source: 'portal',
    definition: def,
    sha256: `sha-${key}`,
    enabled: true,
    nextRunAt: null,
    createdBy: o.createdBy ?? USER_OID,
  }))!;
}

async function startConsent(t: Setup, s: { cookie: string; csrf: string }, key: string) {
  return t.app.inject({
    method: 'POST',
    url: '/auth/schedule-consent',
    headers: { cookie: s.cookie, 'x-adminforge-csrf': s.csrf },
    payload: { key },
  });
}

describe('schedule consent (ADR-014)', () => {
  let t: Setup;
  afterEach(async () => {
    await t.app.close();
  });

  it('the creator signs in for the schedule: grant stored in its own partition, audited, session unchanged', async () => {
    t = await setup();
    const s = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-a1b2c3');
    const before = await t.app.inject({
      method: 'GET',
      url: `/api/schedules/${row.key}`,
      headers: { cookie: s.cookie },
    });
    expect(before.json().runsAs).toEqual({
      kind: 'user',
      name: 'avery@example.com',
      label: 'avery@example.com (their own access)',
      signIn: 'not_signed_in',
      canSignIn: true,
    });

    const start = await startConsent(t, s, row.key);
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().redirect);
    // A deliberate fresh sign-in to the Read app, for the person who is signed in.
    expect(url.searchParams.get('app')).toBe('read');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('login_hint')).toBe('avery@example.com');
    expect(t.auth.authUrls.at(-1)).toMatchObject({ prompt: 'login', maxAge: 0 });

    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=grant-code&state=${url.searchParams.get('state')}`,
      headers: { cookie: `${s.cookie}; ${bindingCookie(start)}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`/schedules/${row.key}`);
    // Redeemed into a partition of its own, then moved to the schedule's.
    const pending = t.auth.redeems.at(-1)!.partitionKey;
    expect(pending).toMatch(/^schedule-pending:/);
    expect(await t.tokenCache.get(grantPartition(row.id))).toContain('redeemed:grant-code');
    expect(await t.tokenBlobs.get(pending)).toBeNull();
    expect(await t.app.schedules.identities.grants.get(row.id)).toMatchObject({
      userOid: USER_OID,
      upn: 'avery@example.com',
      status: 'active',
    });
    expect(t.audit.rows.find((r) => r.action === 'schedule.consented')).toMatchObject({
      result: 'success',
      targetId: row.key,
      actorOid: USER_OID,
    });
    // No new session cookie: the person's own sign-in is unchanged and still works.
    expect(cookieFrom(cb)).toBeUndefined();
    expect((await getMe(t.app, s.cookie)).me).toBeDefined();
    const after = await t.app.inject({
      method: 'GET',
      url: `/api/schedules/${row.key}`,
      headers: { cookie: s.cookie },
    });
    expect(after.json().runsAs).toMatchObject({ signIn: 'signed_in' });
  });

  it('only the creator may sign in for a schedule, and only one that runs as its creator', async () => {
    t = await setup();
    const s = await signIn(t);
    const theirs = await addSchedule(t, 'portal.identity-inactive-users-d4e5f6', { createdBy: OTHER });
    const appOnly = await addSchedule(t, 'portal.identity-inactive-users-a7b8c9', { identity: 'automation' });
    expect((await startConsent(t, s, theirs.key)).json().error.code).toBe('not_schedule_creator');
    expect((await startConsent(t, s, appOnly.key)).json().error.code).toBe('schedule_not_user_identity');
    expect((await startConsent(t, s, 'portal.nope')).statusCode).toBe(404);
    // CSRF: without the header nothing starts.
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/auth/schedule-consent',
      headers: { cookie: s.cookie },
      payload: { key: theirs.key },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('another account coming back from Entra is refused: tokens forgotten, no grant', async () => {
    t = await setup();
    const s = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-112233');
    const start = await startConsent(t, s, row.key);
    const state = new URL(start.json().redirect).searchParams.get('state');
    t.auth.claims = () => ({ oid: OTHER, preferred_username: 'blake@example.com' });
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=grant-code&state=${state}`,
      headers: { cookie: `${s.cookie}; ${bindingCookie(start)}` },
    });
    expect(cb.statusCode).toBeGreaterThanOrEqual(300);
    expect(await t.app.schedules.identities.grants.get(row.id)).toBeNull();
    expect(t.auth.forgets.at(-1)!.partitionKey).toMatch(/^schedule-pending:/);
    expect(await t.tokenBlobs.get(grantPartition(row.id))).toBeNull();
    expect(t.audit.rows.find((r) => r.action === 'schedule.consented')).toMatchObject({
      result: 'failure',
      details: { reason: 'not_schedule_creator' },
    });
  });

  it('deleting the schedule drops the grant', async () => {
    t = await setup();
    const s = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-445566');
    await t.app.schedules.identities.grants.put({
      scheduleId: row.id,
      userOid: USER_OID,
      upn: 'avery@example.com',
      homeAccountId: 'h',
      status: 'active',
      reason: null,
      consentedAt: new Date(),
      checkedAt: null,
    });
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/schedules/${row.key}`,
      headers: { cookie: s.cookie, 'x-adminforge-csrf': s.csrf },
    });
    expect(del.statusCode).toBeLessThan(300);
    expect(await t.app.schedules.identities.grants.get(row.id)).toBeNull();
  });

  async function callback(t: Setup, s: { cookie: string }, start: Awaited<ReturnType<typeof startConsent>>) {
    const state = new URL(start.json().redirect).searchParams.get('state');
    return t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=grant-code&state=${state}`,
      headers: { cookie: `${s.cookie}; ${bindingCookie(start)}` },
    });
  }

  it('a deleted schedule can’t be signed in for, also when it is deleted while Entra asks', async () => {
    t = await setup();
    const s = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-778899');
    const start = await startConsent(t, s, row.key);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/schedules/${row.key}`,
      headers: { cookie: s.cookie, 'x-adminforge-csrf': s.csrf },
    });
    expect(del.statusCode).toBeLessThan(300);
    const cb = await callback(t, s, start);
    expect(cb.statusCode).toBeGreaterThanOrEqual(300);
    expect(await t.app.schedules.identities.grants.get(row.id)).toBeNull();
    expect(await t.tokenBlobs.get(grantPartition(row.id))).toBeNull();
    expect(t.audit.rows.filter((r) => r.action === 'schedule.consented').at(-1)).toMatchObject({
      result: 'failure',
      details: { reason: 'schedule_not_found' },
    });
    expect((await startConsent(t, s, row.key)).json().error.code).toBe('schedule_not_found');
  });

  it('a reused (not fresh) sign-in is refused, and a refused one leaves a working grant alone', async () => {
    t = await setup();
    const s = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-aabbcc');
    // A grant that works, with its tokens.
    expect((await callback(t, s, await startConsent(t, s, row.key))).statusCode).toBe(302);
    const tokens = await t.tokenBlobs.get(grantPartition(row.id));
    expect(tokens).toBeTruthy();
    // Entra reused a sign-in from 10 minutes ago.
    t.auth.claims = () => ({ auth_time: Math.floor(t.clock.now().getTime() / 1000) - 600 });
    const stale = await callback(t, s, await startConsent(t, s, row.key));
    expect(stale.statusCode).toBeGreaterThanOrEqual(300);
    expect(t.audit.rows.filter((r) => r.action === 'schedule.consented').at(-1)).toMatchObject({
      result: 'failure',
      details: { reason: 'signin_not_fresh' },
    });
    expect(await t.tokenBlobs.get(grantPartition(row.id))).toBe(tokens);
    expect(await t.app.schedules.identities.grants.get(row.id)).toMatchObject({ status: 'active' });
    // No auth_time at all (claim not provisioned): refused too.
    t.auth.claims = () => ({ auth_time: undefined });
    await callback(t, s, await startConsent(t, s, row.key));
    expect(t.audit.rows.filter((r) => r.action === 'schedule.consented').at(-1)).toMatchObject({
      details: { reason: 'signin_not_fresh' },
    });
  });

  it('the creator saving it keeps their sign-in; a Portal Admin saving it ends it (audited with the identity)', async () => {
    t = await setup();
    const avery = await signIn(t);
    const row = await addSchedule(t, 'portal.identity-inactive-users-ddeeff');
    expect((await callback(t, avery, await startConsent(t, avery, row.key))).statusCode).toBe(302);
    const body = {
      title: 'Inactive users, with my access',
      cron: '0 6 * * 1',
      timezone: 'UTC',
      identity: { user: 'creator' },
      job: { kind: 'report', ref: 'identity.inactive-users', format: 'csv' },
    };
    const put = (s: { cookie: string; csrf: string }) =>
      t.app.inject({
        method: 'PUT',
        url: `/api/schedules/${row.key}`,
        headers: { cookie: s.cookie, 'x-adminforge-csrf': s.csrf },
        payload: body,
      });
    expect((await put(avery)).statusCode).toBe(200);
    expect(await t.app.schedules.identities.grants.get(row.id)).toMatchObject({ status: 'active' });
    expect(t.audit.rows.filter((r) => r.action === 'schedule.updated').at(-1)).toMatchObject({
      details: { identity: 'user' },
    });

    t.auth.claims = () => ({
      oid: OTHER,
      preferred_username: 'dana@example.com',
      roles: ['Portal.Reader', 'Portal.Operator', 'Portal.Admin'],
    });
    const dana = await signIn(t);
    expect((await put(dana)).statusCode).toBe(200);
    expect(await t.app.schedules.identities.grants.get(row.id)).toBeNull();
    expect(await t.tokenBlobs.get(grantPartition(row.id))).toBeNull();
  });
});
