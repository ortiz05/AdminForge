import { testUserCredentials } from '../../live/lib/entra-login';

// The validation user's sign-in, built once (tests/live/lib/entra-login.ts) for the suite and every script.

describe('testUserCredentials', () => {
  it('reads the UPN, password and TOTP seed from the env', () => {
    expect(
      testUserCredentials({
        AF_TEST_USER_UPN: ' af-tester@example.com ',
        AF_TEST_USER_PASSWORD: 'synthetic-password',
        AF_TEST_USER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
      }),
    ).toEqual({
      upn: 'af-tester@example.com',
      password: 'synthetic-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    });
  });

  it('has no TOTP seed before the MFA bootstrap ran', () => {
    expect(
      testUserCredentials({
        AF_TEST_USER_UPN: 'af-tester@example.com',
        AF_TEST_USER_PASSWORD: 'p',
        AF_TEST_USER_TOTP_SECRET: '',
      }).totpSecret,
    ).toBeUndefined();
  });

  it('names the missing keys (never values) and how to get them', () => {
    expect(() => testUserCredentials({ AF_TEST_USER_UPN: 'af-tester@example.com' })).toThrow(
      /AF_TEST_USER_UPN and AF_TEST_USER_PASSWORD are not set.*provision test-identities/,
    );
  });
});
