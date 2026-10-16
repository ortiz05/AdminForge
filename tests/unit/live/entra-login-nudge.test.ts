import { isRegistrationNudge, REGISTRATION_NUDGE_MESSAGE } from '../../live/lib/entra-login';

// The live sign-in fails fast (instead of timing out) when Entra's registration campaign interrupts it, and says how to
// fix it; the MFA registration that Security Defaults asks for is still completed, not mistaken for the nudge.
describe('live sign-in: registration campaign nudge', () => {
  const REGISTER = 'https://mysignins.microsoft.com/register?csrf_token=x';

  it('recognises the passkey / Authenticator nudge on mysignins', () => {
    expect(
      isRegistrationNudge(REGISTER, 'Example Org Sign in faster with your face, fingerprint, or PIN Next'),
    ).toBe(true);
    expect(isRegistrationNudge(REGISTER, 'Create a passkey to sign in without a password')).toBe(true);
    expect(isRegistrationNudge(REGISTER, 'Skip for now (14 days until this is required)')).toBe(true);
  });

  it('leaves the Security Defaults MFA registration and ordinary sign-in pages alone', () => {
    expect(
      isRegistrationNudge(
        REGISTER,
        "Let's keep your account secure Set up a different authentication app passkey",
      ),
    ).toBe(false);
    expect(
      isRegistrationNudge('https://login.microsoftonline.com/x/oauth2/v2.0/authorize', 'Enter password'),
    ).toBe(false);
    expect(
      isRegistrationNudge('http://localhost:5173/', 'Sign in faster with your face, fingerprint, or PIN'),
    ).toBe(false);
  });

  it('tells the operator which command fixes it', () => {
    expect(REGISTRATION_NUDGE_MESSAGE).toContain('pnpm adminforge provision test-identities');
  });
});
