import type { Page } from '@playwright/test';
import { updateEnvFile } from '@adminforge/config';
import { freshTotp } from './totp';

export interface TestUserCredentials {
  upn: string;
  password: string;
  /** Base32 TOTP seed registered for the dedicated test user (local config only). */
  totpSecret?: string;
}

const SECRET_RE = /\b([A-Za-z2-7]{16,64})\b/;

/**
 * Drives the Microsoft Entra sign-in pages for the dedicated validation user.
 * With Security Defaults on, the first sign-in forces MFA registration: this registers a
 * TOTP "different authentication app", stores the seed in the local env file
 * (AF_TEST_USER_TOTP_SECRET), and later sign-ins answer the code prompt from that seed.
 * Resolves once the browser has left login.microsoftonline.com / mysignins.
 */
export async function signInWithEntra(page: Page, creds: TestUserCredentials, opts: { timeoutMs?: number } = {}): Promise<{ registeredTotp?: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let registeredTotp: string | undefined;
  let secret = creds.totpSecret;

  const visible = async (selector: string) => (await page.locator(selector).count()) > 0 && page.locator(selector).first().isVisible();
  const text = async () => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const isMicrosoft = () => /login\.microsoftonline\.com|mysignins\.microsoft\.com|login\.live\.com/.test(page.url());

  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (!isMicrosoft()) return { registeredTotp };
    const body = await text();

    if (await visible('input[name="loginfmt"]:not([aria-hidden="true"])')) {
      await page.locator('input[name="loginfmt"]').fill(creds.upn);
      await page.locator('#idSIButton9').click();
    } else if (await visible('input[name="passwd"]')) {
      await page.locator('input[name="passwd"]').fill(creds.password);
      await page.locator('#idSIButton9').click();
    } else if (/Let's keep your account secure|More information required/i.test(body) && (await visible('input[type=submit], button'))) {
      await page.locator('#idSubmit_ProofUp_Redirect, input[type=submit][value="Next"], button:has-text("Next")').first().click();
    } else if (/Set up a different authentication app/i.test(body)) {
      await page.getByText(/Set up a different authentication app/i).first().click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /^Next$/ }).first().click();
    } else if (/Scan the QR code/i.test(body)) {
      await page.getByText(/Can.t scan the QR code/i).first().click();
      await page.waitForTimeout(1500);
      const revealed = await text();
      const keyPart = (revealed.split(/Secret key:?/i)[1] ?? '').replace(/Copy key/gi, ' ');
      const match = SECRET_RE.exec(keyPart);
      if (!match) throw new Error('Could not read the authenticator secret key from the registration page.');
      secret = match[1]!.toUpperCase();
      await page.getByRole('button', { name: /^Next$/ }).first().click();
    } else if (/Enter the code|Enter the 6-digit code/i.test(body) && /mysignins/.test(page.url())) {
      if (!secret) throw new Error('Registration asked for a code but no TOTP secret was captured.');
      await page.locator('input').filter({ hasNot: page.locator('[type=hidden]') }).last().fill(await freshTotp(secret));
      await page.getByRole('button', { name: /^Next$/ }).first().click();
      await page.waitForTimeout(3000);
      registeredTotp = secret;
      updateEnvFile({ AF_TEST_USER_TOTP_SECRET: secret });
    } else if (/Success|was successfully registered|Default sign-in method|Authenticator app added/i.test(body) && /mysignins/.test(page.url())) {
      await page.getByRole('button', { name: /^(Done|Next|Continue)$/ }).first().click();
    } else if (await visible('input[name="otc"]')) {
      if (!secret) throw new Error('Sign-in asked for an authenticator code but AF_TEST_USER_TOTP_SECRET is not set.');
      await page.locator('input[name="otc"]').fill(await freshTotp(secret));
      await page.locator('#idSubmit_SAOTCC_Continue, input[type=submit]').first().click();
    } else if (/Verify your identity/i.test(body) && /authenticator app|verification code/i.test(body)) {
      await page.getByText(/Use a verification code|Enter a code from my authenticator app|verification code/i).first().click();
    } else if (/Stay signed in\?/i.test(body)) {
      await page.locator('#idBtn_Back').click();
    } else if (/Permissions requested/i.test(body)) {
      throw new Error('Consent prompt shown: admin consent for the AdminForge app is missing. Run `pnpm adminforge provision entra`.');
    } else if (/AADSTS\d+/.test(body)) {
      throw new Error(`Entra sign-in error: ${/AADSTS\d+[^.]*\./.exec(body)?.[0] ?? body.slice(0, 200)}`);
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Entra sign-in did not finish in time (last page: ${page.url().replace(/[?#].*/, '')}).`);
}
