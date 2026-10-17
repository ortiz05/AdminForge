import type { Page } from '@playwright/test';
import { writeEnvKeys } from '@adminforge/config';
import { mask, maskUrl } from './mask';
import { freshTotp } from './totp';

/**
 * Drives Microsoft's sign-in pages (login.microsoftonline.com, mysignins.microsoft.com) for the dedicated validation
 * user in a Playwright page: UPN, password, the TOTP code — and, on the first sign-in, the MFA registration Security
 * Defaults asks for (it registers an authenticator-app TOTP and stores the seed in the local env file).
 *
 * Inputs: the page, already on a Microsoft sign-in URL, and `testUserCredentials(env)` — or, for the approver fixture
 * ("AF Tester 2"), `testApproverCredentials(env)` — from `<env>.admin.env`.
 * Outputs: resolves once the browser has left Microsoft's pages; `registeredTotp` when it registered a seed (written
 * to the account's TOTP key — AF_TEST_USER_TOTP_SECRET or AF_TEST_APPROVER_TOTP_SECRET — with `writeEnvKeys`, never
 * printed). Errors are masked (`mask`): an AADSTS message or a
 * last-page URL can carry the tenant id or the UPN.
 * Used by lib/portal-session.ts, e2e/portal.live.spec.ts and scripts/register-test-user-mfa.ts; the nudge detection is
 * tested in tests/unit/live/entra-login-nudge.test.ts.
 */

export interface TestUserCredentials {
  upn: string;
  password: string;
  /** Base32 TOTP seed registered for the dedicated test user (local config only). */
  totpSecret?: string;
  /** The admin env key a newly registered seed is written to (default AF_TEST_USER_TOTP_SECRET). */
  totpKey?: 'AF_TEST_USER_TOTP_SECRET' | 'AF_TEST_APPROVER_TOTP_SECRET' | 'AF_TEST_SIGNIN_1_TOTP_SECRET';
}

/**
 * The validation user's sign-in from the env (`loadEnv(process.env, { admin: true })`): AF_TEST_USER_UPN,
 * AF_TEST_USER_PASSWORD and, once the MFA bootstrap ran, AF_TEST_USER_TOTP_SECRET. Throws, naming the keys only, when
 * provisioning hasn't written them.
 */
export function testUserCredentials(env: Readonly<Record<string, string | undefined>>): TestUserCredentials {
  const upn = env.AF_TEST_USER_UPN?.trim();
  const password = env.AF_TEST_USER_PASSWORD;
  if (!upn || !password)
    throw new Error(
      'AF_TEST_USER_UPN and AF_TEST_USER_PASSWORD are not set (they live in <env>.admin.env). Run `pnpm adminforge provision test-identities`.',
    );
  return { upn, password, totpSecret: env.AF_TEST_USER_TOTP_SECRET?.trim() || undefined };
}

/**
 * The approver fixture's sign-in ("AF Tester 2", Playbook.Approver only — approval flows need a second person):
 * AF_TEST_APPROVER_UPN, AF_TEST_APPROVER_PASSWORD and, once its MFA bootstrap ran
 * (`register-test-user-mfa.ts --approver`), AF_TEST_APPROVER_TOTP_SECRET. Throws, naming the keys only, when
 * provisioning hasn't written them.
 */
export function testApproverCredentials(
  env: Readonly<Record<string, string | undefined>>,
): TestUserCredentials {
  const upn = env.AF_TEST_APPROVER_UPN?.trim();
  const password = env.AF_TEST_APPROVER_PASSWORD;
  if (!upn || !password)
    throw new Error(
      'AF_TEST_APPROVER_UPN and AF_TEST_APPROVER_PASSWORD are not set (they live in <env>.admin.env). Add "approver" to AF_TEST_FIXTURES and run `pnpm adminforge provision test-identities`.',
    );
  return {
    upn,
    password,
    totpSecret: env.AF_TEST_APPROVER_TOTP_SECRET?.trim() || undefined,
    totpKey: 'AF_TEST_APPROVER_TOTP_SECRET',
  };
}

const SECRET_RE = /\b([A-Za-z2-7]{16,64})\b/;

/** Pages of the MFA registration Security Defaults asks for (completed below), not the campaign's nudge. */
const MFA_REGISTRATION =
  /Let's keep your account secure|Set up a different authentication app|Scan the QR code/i;
const NUDGE =
  /Sign in faster with your face, fingerprint,? or PIN|\b(create|set up|add) a passkey\b|Skip for now \(\d+ days? until this is required\)/i;

/**
 * Entra's authentication-methods registration campaign: a Microsoft-managed "nudge" to register a passkey or the
 * Authenticator app ("Sign in faster with your face, fingerprint, or PIN") that interrupts sign-in on
 * mysignins.microsoft.com. Headless Chrome can't complete it; `provision test-identities` excludes the validation user.
 */
export function isRegistrationNudge(url: string, body: string): boolean {
  return (
    /mysignins\.microsoft\.com|login\.microsoftonline\.com/.test(url) &&
    !MFA_REGISTRATION.test(body) &&
    NUDGE.test(body)
  );
}

export const REGISTRATION_NUDGE_MESSAGE =
  'Entra interrupted the sign-in with its registration campaign ("Sign in faster with your face, fingerprint, or PIN"), which an unattended sign-in cannot complete. Exclude the validation user from the campaign: run `pnpm adminforge provision test-identities` (`provision status` then shows the exclusion ✓).';

/**
 * Drives the Microsoft Entra sign-in pages for the dedicated validation user.
 * With Security Defaults on, the first sign-in forces MFA registration: this registers a
 * TOTP "different authentication app", stores the seed in the local env file
 * (AF_TEST_USER_TOTP_SECRET), and later sign-ins answer the code prompt from that seed.
 * Resolves once the browser has left login.microsoftonline.com / mysignins.
 */
export async function signInWithEntra(
  page: Page,
  creds: TestUserCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<{ registeredTotp?: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let registeredTotp: string | undefined;
  let secret = creds.totpSecret;

  const visible = async (selector: string) =>
    (await page.locator(selector).count()) > 0 && page.locator(selector).first().isVisible();
  const text = async () =>
    (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ');
  const isMicrosoft = () =>
    /login\.microsoftonline\.com|mysignins\.microsoft\.com|login\.live\.com/.test(page.url());

  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (!isMicrosoft()) return { registeredTotp };
    const body = await text();

    if (isRegistrationNudge(page.url(), body)) {
      throw new Error(REGISTRATION_NUDGE_MESSAGE);
    } else if (await visible('input[name="loginfmt"]:not([aria-hidden="true"])')) {
      await page.locator('input[name="loginfmt"]').fill(creds.upn);
      await page.locator('#idSIButton9').click();
    } else if (await visible('input[name="passwd"]')) {
      await page.locator('input[name="passwd"]').fill(creds.password);
      await page.locator('#idSIButton9').click();
    } else if (
      /Let's keep your account secure|More information required/i.test(body) &&
      (await visible('input[type=submit], button'))
    ) {
      await page
        .locator('#idSubmit_ProofUp_Redirect, input[type=submit][value="Next"], button:has-text("Next")')
        .first()
        .click();
    } else if (/Set up a different authentication app/i.test(body)) {
      await page
        .getByText(/Set up a different authentication app/i)
        .first()
        .click();
      await page.waitForTimeout(1500);
      await page
        .getByRole('button', { name: /^Next$/ })
        .first()
        .click();
    } else if (/Scan the QR code/i.test(body)) {
      await page
        .getByText(/Can.t scan the QR code/i)
        .first()
        .click();
      await page.waitForTimeout(1500);
      const revealed = await text();
      const keyPart = (revealed.split(/Secret key:?/i)[1] ?? '').replace(/Copy key/gi, ' ');
      const match = SECRET_RE.exec(keyPart);
      if (!match) throw new Error('Could not read the authenticator secret key from the registration page.');
      secret = match[1]!.toUpperCase();
      await page
        .getByRole('button', { name: /^Next$/ })
        .first()
        .click();
    } else if (/Enter the code|Enter the 6-digit code/i.test(body) && /mysignins/.test(page.url())) {
      if (!secret) throw new Error('Registration asked for a code but no TOTP secret was captured.');
      await page
        .locator('input')
        .filter({ hasNot: page.locator('[type=hidden]') })
        .last()
        .fill(await freshTotp(secret));
      await page
        .getByRole('button', { name: /^Next$/ })
        .first()
        .click();
      await page.waitForTimeout(3000);
      registeredTotp = secret;
      writeEnvKeys({ [creds.totpKey ?? 'AF_TEST_USER_TOTP_SECRET']: secret });
    } else if (
      /Success|was successfully registered|Default sign-in method|Authenticator app added/i.test(body) &&
      /mysignins/.test(page.url())
    ) {
      // Entra sometimes moves on to "Stay signed in?" by itself while this page is still showing: a short click that
      // may miss, and the loop handles whichever page comes next.
      await page
        .getByRole('button', { name: /^(Done|Next|Continue)$/ })
        .first()
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    } else if (await visible('input[name="otc"]')) {
      if (!secret)
        throw new Error(
          `Sign-in asked for an authenticator code but ${creds.totpKey ?? 'AF_TEST_USER_TOTP_SECRET'} is not set.`,
        );
      await page.locator('input[name="otc"]').fill(await freshTotp(secret));
      await page.locator('#idSubmit_SAOTCC_Continue, input[type=submit]').first().click();
    } else if (/Verify your identity/i.test(body) && /authenticator app|verification code/i.test(body)) {
      await page
        .getByText(/Use a verification code|Enter a code from my authenticator app|verification code/i)
        .first()
        .click();
    } else if (/Stay signed in\?/i.test(body)) {
      await page.locator('#idBtn_Back').click();
    } else if (/Permissions requested/i.test(body)) {
      throw new Error(
        'Consent prompt shown: admin consent for the AdminForge app is missing. Run `pnpm adminforge provision entra`.',
      );
    } else if (/AADSTS\d+/.test(body)) {
      throw new Error(
        `Entra sign-in error: ${mask(/AADSTS\d+[^.]*\./.exec(body)?.[0] ?? body.slice(0, 200))}`,
      );
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Entra sign-in did not finish in time (last page: ${maskUrl(page.url())}).`);
}
