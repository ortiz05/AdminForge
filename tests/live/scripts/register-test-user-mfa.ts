// Live: one-time (idempotent) MFA bootstrap for the dedicated validation user — or, with --approver, for the approver
// fixture ("AF Tester 2"). Signs in to the AdminForge Read app with a real authorization-code + PKCE request;
// registers a TOTP authenticator if Entra asks (Security Defaults) and stores its seed as AF_TEST_USER_TOTP_SECRET
// (AF_TEST_APPROVER_TOTP_SECRET with --approver) in <env>.admin.env (lib/entra-login.ts). The authorization code is
// never redeemed: the browser stops at the callback URL.
//
// Usage (repository root; the account enabled — see tests/live/README.md):
//   pnpm exec tsx tests/live/scripts/register-test-user-mfa.ts [--approver] [failure-screenshot.png]
// Inputs: the env file and <env>.admin.env (AF_TENANT_ID, AF_READ_CLIENT_ID, PUBLIC_BASE_URL, the validation user).
// Output: whether MFA was registered now or already, whether the callback was reached and a code issued. On failure: a
//   masked error, the last page (masked URL) and a screenshot, by default `<AF_LIVE_OUT>/register-test-user-mfa-failure.png`
//   (lib/output.ts); exit code 1.
// Safety: the validation accounts only; the TOTP seed goes to the local admin env file, never to the output.
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
// The CLI's authorize-URL and PKCE helpers (the same request `provision status` checks), not a copy.
import { buildAuthorizeUrl, pkceChallenge } from '@adminforge/cli/src/provision/auth';
import { signInWithEntra, testApproverCredentials, testUserCredentials } from '../lib/entra-login';
import { maskError, maskUrl } from '../lib/mask';
import { liveOutFile } from '../lib/output';

const env = loadEnv(process.env, { admin: true });
if (!env.AF_TENANT_ID || !env.AF_READ_CLIENT_ID)
  throw new Error(
    'AF_TENANT_ID and AF_READ_CLIENT_ID must be set in the env file (`pnpm adminforge env check`).',
  );
const args = process.argv.slice(2);
const approver = args.includes('--approver');
const screenshot = args.find((a) => !a.startsWith('--'));
const creds = approver ? testApproverCredentials(env) : testUserCredentials(env);
const redirect = `${env.PUBLIC_BASE_URL ?? 'http://localhost:5173'}/auth/callback`;
const authorize = new URL(
  buildAuthorizeUrl({
    tenantId: env.AF_TENANT_ID,
    clientId: env.AF_READ_CLIENT_ID,
    redirectUri: redirect,
    scopes: ['openid', 'profile', 'offline_access'],
    state: `mfa-bootstrap-${randomBytes(8).toString('hex')}`,
    // A fresh verifier each time; it is thrown away (the code is never redeemed).
    codeChallenge: pkceChallenge(randomBytes(32).toString('base64url')),
  }),
);
// Always show the sign-in pages, even with a Microsoft session cookie in the browser profile.
authorize.searchParams.set('prompt', 'login');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
let reached = false;
await page.route(`${redirect}**`, (r) => {
  reached = true;
  return r.fulfill({ status: 200, body: 'ok' });
});
try {
  await page.goto(authorize.toString());
  const { registeredTotp } = await signInWithEntra(page, creds);
  const code = new URL(page.url()).searchParams.get('code');
  console.log(
    `MFA ${registeredTotp ? 'registered now' : 'already registered'}; reached callback: ${reached}; authorization code issued: ${Boolean(code)}`,
  );
} catch (e) {
  await page.screenshot({
    path: liveOutFile(screenshot, 'register-test-user-mfa-failure.png'),
  });
  console.error(maskError(e), '| last url:', maskUrl(page.url()));
  process.exitCode = 1;
} finally {
  await browser.close();
}
