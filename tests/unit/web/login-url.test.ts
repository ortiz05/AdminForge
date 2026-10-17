import { loginUrl } from '@adminforge/web/src/lib/api';
import { ApiErrorBody } from '@adminforge/schemas';

// The SPA follows a `login` from an error body to sign in again. Only this site's own /auth/login is ever followed,
// with its claims challenge and the page to come back to — never another origin, a `//host` path or another path.
const here = {
  origin: 'https://portal.example.com',
  pathname: '/p/identity.users',
  search: '?q=a',
} as Location;

describe('loginUrl', () => {
  it('keeps the claims challenge and returns to the current page', () => {
    expect(loginUrl('/auth/login?returnTo=%2F&claims=eyJ4Ijox', here)).toBe(
      '/auth/login?claims=eyJ4Ijox&returnTo=%2Fp%2Fidentity.users%3Fq%3Da',
    );
  });

  it.each([
    '//evil.example/x',
    '/.//evil.example/x',
    'https://a//evil.example/x',
    'https://evil.example/auth/login?claims=x',
    '/auth/logout',
    '/auth/login/../../elsewhere',
    'javascript:alert(1)',
  ])('never leaves the sign-in path for %j', (login) => {
    const out = loginUrl(login, here);
    expect(out.startsWith('/auth/login?')).toBe(true);
    expect(new URL(out, here.origin).origin).toBe(here.origin);
    expect(out).not.toContain('claims=x');
  });
});

describe('error body schema', () => {
  it('accepts only the app’s own /auth/login as `login`', () => {
    const body = (login: string) => ({ error: { code: 'reauth', message: 'm', login } });
    expect(ApiErrorBody.safeParse(body('/auth/login?returnTo=%2F')).success).toBe(true);
    expect(ApiErrorBody.safeParse(body('//evil.example/x')).success).toBe(false);
    expect(ApiErrorBody.safeParse(body('https://evil.example/auth/login')).success).toBe(false);
  });
});
