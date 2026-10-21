import { loadConfig } from '@adminforge/api/src/config';
import {
  AddressCap,
  addressKey,
  rateLimitKey,
  SIGNIN_FAILURE_AUDITS_PER_MINUTE,
  SignInFailureAudits,
} from '@adminforge/api/src/rate-limit';
import { ApiErrorBody } from '@adminforge/schemas';
import { entraConfig, FakeAuthClient, makeApp, mockConfig } from './helpers';

// Sign-in and anonymous requests are limited per client address (IPv6 by its /64), so an invented session cookie
// buys no fresh allowance; failed-sign-in audit events are throttled per address; background requests never double a
// route's own limit; production refuses TRUST_PROXY=true.

const cookie = (sid: string) => `adminforge-dev=${sid}`;

describe('sign-in routes count per address, whatever cookie comes with them', () => {
  it('invented cookies on /auth/login share one allowance', async () => {
    const { app } = await makeApp(entraConfig({ RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE: '2' }), {
      auth: new FakeAuthClient(),
    });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/auth/login',
            headers: { cookie: cookie(`${'x'.repeat(40)}${i}`) },
          })
        ).statusCode,
      ).toBe(302);
    const limited = await app.inject({
      method: 'GET',
      url: '/auth/login',
      headers: { cookie: cookie('y'.repeat(43)) },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});

describe('requests without a valid session', () => {
  it('share one allowance per address, invented cookies or not', async () => {
    const { app } = await makeApp(mockConfig({ RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE: '3' }));
    for (let i = 0; i < 3; i++)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/nav',
            headers: { cookie: cookie(`${'s'.repeat(40)}${i}`) },
          })
        ).statusCode,
      ).toBe(401);
    const capped = await app.inject({
      method: 'GET',
      url: '/api/nav',
      headers: { cookie: cookie('z'.repeat(43)) },
    });
    expect(capped.statusCode).toBe(429);
    expect(ApiErrorBody.parse(capped.json()).error.code).toBe('rate_limited');
    // Health checks don't count.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('addressKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:0:0:0:9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s → %s', (ip, key) => {
    expect(addressKey(ip)).toBe(key);
  });

  it('two addresses of one /64 share the per-address cap', () => {
    const cap = new AddressCap(1);
    expect(cap.allow(addressKey('2001:db8:1:2::1'))).toBe(true);
    expect(cap.allow(addressKey('2001:db8:1:2::ffff'))).toBe(false);
    expect(cap.allow(addressKey('2001:db8:1:3::1'))).toBe(true);
  });
});

describe('rateLimitKey', () => {
  const req = (route: string, headers: Record<string, string> = {}, ownLimit = false) =>
    ({
      cookies: { 'adminforge-dev': 'a'.repeat(43) },
      headers,
      ip: '2001:db8:1:2::5',
      routeOptions: { url: route, config: ownLimit ? { rateLimit: { max: 10 } } : {} },
    }) as never;

  it('keys sign-in by address, the rest by session', () => {
    expect(rateLimitKey(req('/auth/login'), 'adminforge-dev')).toBe('ip:2001:db8:1:2::/64');
    expect(rateLimitKey(req('/auth/callback'), 'adminforge-dev')).toBe('ip:2001:db8:1:2::/64');
    expect(rateLimitKey(req('/api/nav'), 'adminforge-dev')).toMatch(/^s:/);
  });

  it('background requests get their own allowance only under the global limit', () => {
    const bg = { 'x-adminforge-background': '1' };
    expect(rateLimitKey(req('/api/nav', bg), 'adminforge-dev')).toMatch(/\|bg$/);
    expect(rateLimitKey(req('/auth/arm/extend', bg, true), 'adminforge-dev')).not.toMatch(/\|bg$/);
  });
});

describe('failed-sign-in audit events', () => {
  it('are written up to the limit per address and minute, then counted and reported with the next', () => {
    let now = 0;
    const audits = new SignInFailureAudits(() => now);
    const turns = Array.from({ length: SIGNIN_FAILURE_AUDITS_PER_MINUTE + 5 }, () =>
      audits.next('203.0.113.9'),
    );
    expect(turns.filter((t) => t.write)).toHaveLength(SIGNIN_FAILURE_AUDITS_PER_MINUTE);
    // Another address isn't affected.
    expect(audits.next('198.51.100.1')).toEqual({ write: true, suppressed: 0 });
    now = 60_000;
    expect(audits.next('203.0.113.9')).toEqual({ write: true, suppressed: 5 });
    expect(audits.next('203.0.113.9')).toEqual({ write: true, suppressed: 0 });
  });
});

describe('TRUST_PROXY in production', () => {
  const prod = (TRUST_PROXY: string) => () =>
    loadConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
      AUTH_MODE: 'entra',
      DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
      TRUST_PROXY,
    });

  it('refuses true (anyone could forge the client address)', () => {
    expect(prod('true')).toThrow(/TRUST_PROXY: must name the proxies/);
  });

  it('accepts named proxies', () => {
    expect(prod('loopback')).not.toThrow(/TRUST_PROXY/);
  });
});
