// One-time (idempotent) MFA bootstrap for the dedicated validation user.
// Signs in to the AdminForge Read app; registers a TOTP method if Entra asks; stores the seed in local config.
import { chromium } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { signInWithEntra } from '../lib/entra-login';

const env = loadEnv();
const redirect = `${env.PUBLIC_BASE_URL ?? 'http://localhost:5173'}/auth/callback`;
const url = new URL(`https://login.microsoftonline.com/${env.AF_TENANT_ID}/oauth2/v2.0/authorize`);
url.search = new URLSearchParams({
  client_id: env.AF_READ_CLIENT_ID!,
  response_type: 'code',
  redirect_uri: redirect,
  response_mode: 'query',
  scope: 'openid profile offline_access',
  state: 'mfa-bootstrap',
  prompt: 'login',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
}).toString();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
let reached = false;
await page.route(`${redirect}**`, (r) => {
  reached = true;
  return r.fulfill({ status: 200, body: 'ok' });
});
try {
  await page.goto(url.toString());
  const { registeredTotp } = await signInWithEntra(page, {
    upn: env.AF_TEST_USER_UPN!,
    password: env.AF_TEST_USER_PASSWORD!,
    totpSecret: env.AF_TEST_USER_TOTP_SECRET,
  });
  const code = new URL(page.url()).searchParams.get('code');
  console.log(
    `MFA ${registeredTotp ? 'registered now' : 'already registered'}; reached callback: ${reached}; authorization code issued: ${Boolean(code)}`,
  );
} catch (e) {
  await page.screenshot({ path: process.argv[2] ?? '/tmp/af-mfa-failure.png' });
  console.error((e as Error).message, '| last url:', page.url().replace(/[?#].*/, ''));
  process.exitCode = 1;
} finally {
  await browser.close();
}
