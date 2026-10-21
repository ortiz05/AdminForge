import {
  MemoryPreauthStore,
  PREAUTH_EVICT_AFTER_MS,
  PREAUTH_MAX_PENDING,
  PREAUTH_TTL_MS,
  type PreauthRecord,
} from '@adminforge/api/src/auth/preauth-store';
import { ApiErrorBody } from '@adminforge/schemas';
import { Clock } from '../lib/clock';
import { bindingCookie, entraConfig, FakeAuthClient, MINUTE } from './helpers';
import { buildTestApp, sessionFor } from './support/app';
import { AVERY, OPERATOR } from './support/people';

/**
 * S-28: every anonymous `GET /auth/login` writes a pending sign-in (state, PKCE verifier, nonce) to the one SQLite
 * writer, and the per-address limits don't bound the table when many addresses send them. A global cap bounds the
 * pending (unexpired) round trips. When it is full the oldest pending sign-in that has had two minutes makes room, so
 * a flood from a few addresses can't lock people out of signing in; only when every pending sign-in is younger than
 * that is a new start refused with a plain 503 `signin_busy`, without writing. Arming and schedule consent (which need
 * a signed-in session, limited per session) always start and are never evicted. Purging is unchanged.
 */
async function entraApp(maxPending: number) {
  const clock = new Clock();
  const auth = new FakeAuthClient();
  auth.now = clock.now;
  const preauth = new MemoryPreauthStore({ maxPending });
  const t = await buildTestApp(entraConfig(), { clock, deps: { auth, preauth } });
  return { ...t, preauth, auth };
}

const login = (t: Awaited<ReturnType<typeof entraApp>>, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F', headers });

/** A sign-in record that started at `startedAt` (ms). */
const record = (state: string, startedAt: number, sessionIdHash: string | null = null): PreauthRecord => ({
  state,
  kind: sessionIdHash ? 'write' : 'read',
  verifier: 'v',
  nonce: 'n',
  returnTo: '/',
  sessionIdHash,
  bindingHash: 'b',
  details: null,
  expiresAt: new Date(startedAt + PREAUTH_TTL_MS),
});

describe('a global cap on pending sign-ins', () => {
  it('refuses a new sign-in start while every pending one is younger than two minutes, plainly and without writing', async () => {
    const t = await entraApp(3);
    for (let i = 0; i < 3; i++) expect((await login(t)).statusCode).toBe(302);
    expect(t.preauth.rows.size).toBe(3);

    const res = await login(t);
    expect(res.statusCode).toBe(503);
    const { error } = ApiErrorBody.parse(res.json());
    expect(error).toMatchObject({
      code: 'signin_busy',
      message: expect.stringMatching(/too many sign-ins/i),
      hint: expect.stringMatching(/wait a few minutes/i),
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(error)).not.toMatch(/preauth|PREAUTH|SQLite|_MAX/);
    expect(t.preauth.rows.size).toBe(3);
    expect(t.auth.authUrls).toHaveLength(3);
    await t.app.close();
  });

  it('makes room by ending the oldest pending sign-in once it has had two minutes', async () => {
    const t = await entraApp(3);
    const first = await login(t);
    t.clock.advance(MINUTE);
    await login(t);
    await login(t);
    t.clock.advance(PREAUTH_EVICT_AFTER_MS - MINUTE);
    expect((await login(t)).statusCode).toBe(302);
    expect(t.preauth.rows.size).toBe(3);
    // The evicted sign-in's callback says it expired; the others still finish.
    const state = new URL(first.headers.location as string).searchParams.get('state');
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: bindingCookie(first)! },
    });
    expect(cb.statusCode).toBe(400);
    expect(cb.json().error.code).toBe('invalid_state');
    await t.app.close();
  });

  it('keeps a real sign-in for minutes while a few addresses flood the table', async () => {
    // 100 places; a flood of 25 starts a minute (a full table cycles every 4 minutes).
    const store = new MemoryPreauthStore({ maxPending: 100 });
    const t0 = Date.parse('2026-10-21T08:00:00Z');
    let refused = 0;
    for (let s = 0; s < 12 * 60; s += 2.4) {
      const at = t0 + s * 1000;
      if (Math.abs(s - 300) < 1.2) await store.put(record('real', at));
      await store.put(record(`flood-${s}`, at)).catch(() => refused++);
      if (Math.abs(s - 480) < 1.2)
        expect(await store.take('real'), 'still pending 3 minutes later').not.toBeNull();
    }
    expect(refused).toBe(0);
    expect(store.rows.size).toBeLessThanOrEqual(100);
  });

  it('refuses rather than writes when starts come faster than the table can hold them for two minutes', async () => {
    // 100 places, 200 starts a minute: every pending sign-in is younger than two minutes when the table is full.
    const store = new MemoryPreauthStore({ maxPending: 100 });
    const t0 = Date.parse('2026-10-21T08:00:00Z');
    let refused = 0;
    for (let i = 0; i < 400; i++)
      await store.put(record(`flood-${i}`, t0 + i * 300)).catch((err) => {
        expect(err).toMatchObject({ status: 503, code: 'signin_busy' });
        refused++;
      });
    expect(refused).toBeGreaterThan(0);
    expect(store.rows.size).toBe(100);
  });

  it('sends a browser navigation to the problem page', async () => {
    const t = await entraApp(1);
    await login(t);
    const res = await login(t, { 'sec-fetch-mode': 'navigate' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/sign-in-problem\?code=signin_busy&ref=/);
    await t.app.close();
  });

  it('counts only round trips that are still pending: expired ones free their place before any purge', async () => {
    const t = await entraApp(2);
    await login(t);
    await login(t);
    expect((await login(t)).statusCode).toBe(503);
    t.clock.advance(PREAUTH_TTL_MS + 1);
    expect((await login(t)).statusCode).toBe(302);
    expect(t.preauth.rows.size).toBe(3);
    await t.app.close();
  });

  it('still starts arming for a signed-in Operator when sign-ins are full, and never evicts it', async () => {
    const t = await entraApp(1);
    const operator = await sessionFor(t, AVERY, OPERATOR);
    const arm = await operator.post('/auth/arm', { minutes: 30, reason: 'Disable test user' });
    expect(arm.statusCode).toBe(200);
    expect(arm.json().redirect).toMatch(/^https:\/\/login\.example\.test\/authorize\?app=write/);
    // The arm round trip fills the only place: sign-ins are refused, however old it gets, and it stays.
    t.clock.advance(PREAUTH_EVICT_AFTER_MS + MINUTE);
    expect((await login(t)).statusCode).toBe(503);
    expect([...t.preauth.rows.values()].map((r) => r.kind)).toEqual(['write']);
    expect((await operator.post('/auth/arm', { minutes: 30, reason: 'Disable test user' })).statusCode).toBe(
      200,
    );
    await t.app.close();
  });

  it('holds 5,000 pending sign-ins by default', async () => {
    expect(PREAUTH_MAX_PENDING).toBe(5_000);
    expect(PREAUTH_EVICT_AFTER_MS).toBe(2 * MINUTE);
    const store = new MemoryPreauthStore();
    const now = Date.now();
    for (let i = 0; i < PREAUTH_MAX_PENDING; i++) await store.put(record(`s${i}`, now));
    await expect(store.put(record('one-more', now))).rejects.toMatchObject({
      status: 503,
      code: 'signin_busy',
    });
    await store.put(record('arm', now, 'session-hash'));
    expect(store.rows.size).toBe(PREAUTH_MAX_PENDING + 1);
  });
});
