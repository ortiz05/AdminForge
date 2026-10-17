import { AddressCap, rateLimitKey } from '@adminforge/api/src/rate-limit';
import { ApiErrorBody } from '@adminforge/schemas';
import { makeApp, mockConfig } from './helpers';

// Behind a corporate NAT every engineer shares one address: the request limit counts per session (per address only
// before sign-in), background requests count apart, and one address across all its sessions has a coarse cap.

const COOKIE = 'adminforge-dev';
const cookie = (sid: string) => `${COOKIE}=${sid}`;
const SID_A = 'a'.repeat(43);
const SID_B = 'b'.repeat(43);

describe('rate limits per session', () => {
  it('two sessions from one address each get their own allowance', async () => {
    const { app } = await makeApp(mockConfig({ RATE_LIMIT_PER_MINUTE: '3' }));
    for (let i = 0; i < 3; i++)
      expect(
        (await app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookie(SID_A) } })).statusCode,
      ).toBe(401);
    const limited = await app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookie(SID_A) } });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorBody.parse(limited.json()).error.code).toBe('rate_limited');
    // Same address, another session: not limited.
    expect(
      (await app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookie(SID_B) } })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('background requests have their own allowance, so polling can’t starve a click', async () => {
    const { app } = await makeApp(
      mockConfig({ RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_BACKGROUND_PER_MINUTE: '2' }),
    );
    const bg = { cookie: cookie(SID_A), 'x-adminforge-background': '1' };
    for (let i = 0; i < 2; i++) await app.inject({ method: 'GET', url: '/api/nav', headers: bg });
    expect((await app.inject({ method: 'GET', url: '/api/nav', headers: bg })).statusCode).toBe(429);
    expect(
      (await app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookie(SID_A) } })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('one address is capped across all its sessions (invented cookies don’t buy more)', async () => {
    const { app } = await makeApp(
      mockConfig({ RATE_LIMIT_PER_MINUTE: '100', RATE_LIMIT_PER_ADDRESS_PER_MINUTE: '4' }),
    );
    for (let i = 0; i < 4; i++)
      await app.inject({
        method: 'GET',
        url: '/api/nav',
        headers: { cookie: cookie(`${'s'.repeat(40)}${i}`) },
      });
    const capped = await app.inject({
      method: 'GET',
      url: '/api/nav',
      headers: { cookie: cookie('z'.repeat(43)) },
    });
    expect(capped.statusCode).toBe(429);
    expect(ApiErrorBody.parse(capped.json()).error).toMatchObject({ code: 'rate_limited' });
    await app.close();
  });
});

describe('rateLimitKey / AddressCap', () => {
  const req = (cookies: Record<string, string>, headers: Record<string, string> = {}) =>
    ({ cookies, headers, ip: '203.0.113.7' }) as never;

  it('hashes the session cookie (never the value itself), falls back to the address', () => {
    const key = rateLimitKey(req({ [COOKIE]: SID_A }), COOKIE);
    expect(key).toMatch(/^s:[A-Za-z0-9_-]{22}$/);
    expect(key).not.toContain(SID_A);
    expect(rateLimitKey(req({ [COOKIE]: SID_A }, { 'x-adminforge-background': '1' }), COOKIE)).toBe(
      `${key}|bg`,
    );
    expect(rateLimitKey(req({}), COOKIE)).toBe('ip:203.0.113.7');
    expect(rateLimitKey(req({ [COOKIE]: 'short' }), COOKIE)).toBe('ip:203.0.113.7');
  });

  it('counts per minute and starts a new window', () => {
    let now = 0;
    const cap = new AddressCap(2, () => now);
    expect([cap.allow('a'), cap.allow('a'), cap.allow('a'), cap.allow('b')]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    now = 60_000;
    expect(cap.allow('a')).toBe(true);
  });
});
