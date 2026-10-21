import {
  MemoryPreauthStore,
  PREAUTH_MAX_PENDING,
  PREAUTH_TTL_MS,
  type PreauthRecord,
} from '@adminforge/api/src/auth/preauth-store';
import { ApiErrorBody } from '@adminforge/schemas';
import { Clock } from '../lib/clock';
import { entraConfig, FakeAuthClient } from './helpers';
import { buildTestApp, sessionFor } from './support/app';
import { AVERY, OPERATOR } from './support/people';

/**
 * S-28: every anonymous `GET /auth/login` writes a pending sign-in (state, PKCE verifier, nonce) to the one SQLite
 * writer, and the per-address limits don't bound the table when many addresses send them. A global cap on pending
 * (unexpired) round trips refuses new sign-in starts with a plain 503 `signin_busy` — without writing — while arming
 * and schedule consent (which need a signed-in session, limited per session) still start. Purging is unchanged.
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

describe('a global cap on pending sign-ins', () => {
  it('refuses a new sign-in start when the cap is reached, in plain words and without writing', async () => {
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

  it('still starts arming for a signed-in Operator when sign-ins are full', async () => {
    const t = await entraApp(1);
    await login(t);
    const operator = await sessionFor(t, AVERY, OPERATOR);
    const arm = await operator.post('/auth/arm', { minutes: 30, reason: 'Disable test user' });
    expect(arm.statusCode).toBe(200);
    expect(arm.json().redirect).toMatch(/^https:\/\/login\.example\.test\/authorize\?app=write/);
    expect(t.preauth.rows.size).toBe(2);
    await t.app.close();
  });

  it('holds 5,000 pending sign-ins by default', async () => {
    expect(PREAUTH_MAX_PENDING).toBe(5_000);
    const store = new MemoryPreauthStore();
    const expiresAt = new Date(Date.now() + PREAUTH_TTL_MS);
    const record = (state: string, sessionIdHash: string | null = null): PreauthRecord => ({
      state,
      kind: sessionIdHash ? 'write' : 'read',
      verifier: 'v',
      nonce: 'n',
      returnTo: '/',
      sessionIdHash,
      bindingHash: 'b',
      details: null,
      expiresAt,
    });
    for (let i = 0; i < PREAUTH_MAX_PENDING; i++) await store.put(record(`s${i}`));
    await expect(store.put(record('one-more'))).rejects.toMatchObject({ status: 503, code: 'signin_busy' });
    await store.put(record('arm', 'session-hash'));
    expect(store.rows.size).toBe(PREAUTH_MAX_PENDING + 1);
  });
});
