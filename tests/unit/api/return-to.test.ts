import { safeReturnTo } from '@adminforge/api/src/auth/return-to';

describe('safeReturnTo', () => {
  it.each(['/', '/identity/users?x=1', '/p/identity.users', '/p/identity.users?q=avery%40example.com#top'])(
    'keeps %s',
    (v) => {
      expect(safeReturnTo(v)).toBe(v);
    },
  );

  it.each([
    '//evil.com',
    '//evil.com/path',
    '/\\evil.com',
    '\\\\evil.com',
    'https://evil.com',
    'http://localhost:5173/x',
    'javascript:alert(1)',
    'data:text/html,hi',
    'evil.com',
    '',
    '/auth/login?returnTo=%2F',
    '/auth/callback',
    '/x\nSet-Cookie: a=b',
    '/x\u0000',
    `/${'a'.repeat(3000)}`,
    // Dot segments that normalise to a scheme-relative URL (open redirect).
    '/.//evil.com',
    '/a/..//evil.com',
    '/%2e//evil.com',
    '/./%2e//evil.com/phish',
  ])('rejects %j', (v) => {
    expect(safeReturnTo(v)).toBe('/');
  });

  it('rejects non-strings and supports a custom fallback', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(['/a'])).toBe('/');
    expect(safeReturnTo('//evil', '/home')).toBe('/home');
  });

  it('normalises dot segments without leaving the origin', () => {
    expect(safeReturnTo('/a/../../b')).toBe('/b');
    expect(safeReturnTo('/%2e%2e/auth/login')).toBe('/');
  });
});
