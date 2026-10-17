import { toAppError } from '@adminforge/api/src/errors';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import { toErrorInfo } from '@adminforge/api/src/datasources/executor';

// CLAUDE.md rule 10: every error says what to do. A `reauth` carries a hint and, for a page's datasources, the login
// URL — so the page can offer "Sign in again" once instead of a "Try again" that fails the same way.
describe('reauth errors', () => {
  it('the response says what to do and where to sign in', () => {
    const e = toAppError(new ReauthRequired('read'));
    expect(e.status).toBe(401);
    expect(e.code).toBe('reauth');
    expect(e.extras.hint).toMatch(/^Sign in again/);
    expect(e.extras.login).toMatch(/^\/auth\/login/);
  });

  it('a datasource failure keeps the hint and the login URL', () => {
    const info = toErrorInfo(new ReauthRequired('read'));
    expect(info).toMatchObject({ code: 'reauth', hint: expect.stringMatching(/^Sign in again/) });
    expect(info.login).toMatch(/^\/auth\/login/);
  });

  it('other datasource failures carry no login URL', () => {
    expect(toErrorInfo(new Error('boom')).login).toBeUndefined();
  });
});
