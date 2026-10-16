import { testApproverCredentials, testUserCredentials } from '../../live/lib/entra-login';

// The approver fixture's sign-in ("AF Tester 2", tests/live/lib/entra-login.ts): its own keys, and its own TOTP key,
// so registering its MFA never overwrites the validation user's seed.

describe('testApproverCredentials', () => {
  it('reads the approver keys and names its own TOTP key', () => {
    expect(
      testApproverCredentials({
        AF_TEST_APPROVER_UPN: ' af-approver@example.com ',
        AF_TEST_APPROVER_PASSWORD: 'synthetic-password',
        AF_TEST_APPROVER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
        AF_TEST_USER_TOTP_SECRET: 'KRSXG5CTMVRXEZLU',
      }),
    ).toEqual({
      upn: 'af-approver@example.com',
      password: 'synthetic-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpKey: 'AF_TEST_APPROVER_TOTP_SECRET',
    });
  });

  it('the validation user keeps the default key', () => {
    expect(
      testUserCredentials({ AF_TEST_USER_UPN: 'af-tester@example.com', AF_TEST_USER_PASSWORD: 'p' }).totpKey,
    ).toBeUndefined();
  });

  it('names the missing keys (never values) and how to get them', () => {
    expect(() => testApproverCredentials({ AF_TEST_APPROVER_UPN: 'af-approver@example.com' })).toThrow(
      /AF_TEST_APPROVER_UPN and AF_TEST_APPROVER_PASSWORD are not set.*"approver".*AF_TEST_FIXTURES/,
    );
  });
});
