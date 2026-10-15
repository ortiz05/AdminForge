import { providerError } from '@adminforge/api/src/auth/entra-errors';

const err = (kind: 'read' | 'write', error: string, description?: string) =>
  providerError(kind, { error, error_description: description });

describe('providerError: Entra errors → plain-language AppErrors', () => {
  it('returns nothing without an error parameter', () => {
    expect(providerError('read', { code: 'x' })).toBeUndefined();
  });

  it.each([
    ['read', 'access_denied', 'AADSTS50105: not assigned', 'no_portal_role', 403],
    ['write', 'access_denied', 'AADSTS50105: not assigned', 'no_write_access', 403],
    [
      'read',
      'invalid_client',
      'AADSTS65001: The user or administrator has not consented',
      'consent_required',
      403,
    ],
    ['read', 'consent_required', undefined, 'consent_required', 403],
    [
      'read',
      'access_denied',
      'AADSTS53003: Access has been blocked by Conditional Access',
      'blocked_by_policy',
      403,
    ],
    [
      'read',
      'invalid_request',
      'AADSTS50020: User account from identity provider does not exist',
      'wrong_tenant',
      400,
    ],
    ['read', 'access_denied', 'The user has denied access to the scope requested', 'signin_cancelled', 400],
    ['write', 'access_denied', undefined, 'arm_cancelled', 400],
    ['read', 'temporarily_unavailable', undefined, 'entra_unavailable', 503],
    ['read', 'invalid_grant', 'AADSTS70000: something new', 'signin_failed', 400],
    ['write', 'invalid_grant', 'AADSTS70000: something new', 'arm_failed', 400],
  ] as const)('%s %s (%s) → %s', (kind, error, description, code, status) => {
    const e = err(kind, error, description)!;
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
    expect(e.extras.hint).toBeTruthy();
  });

  it('keeps the AADSTS number as detail and never shows Entra’s description', () => {
    const e = err(
      'read',
      'access_denied',
      'AADSTS50105: The signed in user is not assigned.\r\nTrace ID: abc',
    )!;
    expect(e.extras.detail).toBe('AADSTS50105');
    expect(e.message).not.toMatch(/AADSTS|Trace/);
  });

  it('uses the OAuth error as detail when there is no AADSTS number, stripped to safe characters', () => {
    expect(err('read', 'access_denied<script>')!.extras.detail).toBe('access_deniedscript');
  });
});
