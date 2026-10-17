// Live: real sign-ins for the `sign-ins` test fixture's two accounts, so the sign-in pages, report-only Conditional
// Access results and inactive-user reports have data a tenant only gets from people signing in:
//   - AF-Test-SignIn-01 signs in to My Apps successfully (MFA by its TOTP seed — registered on the first run, like the
//     validation user's; stored as AF_TEST_SIGNIN_1_TOTP_SECRET);
//   - AF-Test-SignIn-02 tries a wrong password, then signs in with its real password while disabled.
// Each account is enabled only for its own sign-in (and the run stops if it can't be: no marker, missing); both are
// disabled at the end, whatever happened, Ctrl-C and SIGTERM included (and
// `pnpm adminforge provision test-identities --disable` disables them too).
//
// Usage (repository root; after `pnpm adminforge provision test-identities` with "sign-ins" in AF_TEST_FIXTURES):
//   pnpm exec tsx tests/live/scripts/generate-sign-ins.ts [failure-screenshot.png]
// Inputs: the env file and <env>.admin.env (AF_TENANT_ID, AF_PRIMARY_DOMAIN, the provisioner, AF_TEST_SIGNIN_*).
// Output: one line per sign-in with its outcome — no UPNs, ids or passwords; masked errors and a screenshot on failure
//   (default `<AF_LIVE_OUT>/generate-sign-ins-failure.png`); exit code 1 when an expected outcome didn't happen.
// Safety: only accounts carrying the sign-ins marker are enabled or disabled; passwords and the TOTP seed stay in the
//   admin env file. Sign-ins go to My Apps (Microsoft's first-party portal): no consent, no portal role needed.
import { chromium, type Page } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { provisionerClients } from '@adminforge/cli/src/provision/clients';
import { provisionSettings } from '@adminforge/cli/src/provision/settings';
import { setSignInAccountsEnabled, signInAccounts } from '@adminforge/cli/src/provision/sign-ins-fixture';
import { signInWithEntra } from '../lib/entra-login';
import { mask, maskError, maskUrl } from '../lib/mask';
import { liveOutFile } from '../lib/output';

const env = loadEnv(process.env, { admin: true });
const settings = provisionSettings(env);
if (!settings.primaryDomain) throw new Error('AF_PRIMARY_DOMAIN must be set in the env file.');
const [one, two] = signInAccounts(settings.primaryDomain);
for (const a of [one!, two!])
  if (env[a.upnKey]?.toLowerCase() !== a.upn.toLowerCase() || !env[a.passwordKey])
    throw new Error(
      `${a.upnKey} / ${a.passwordKey} are not set: add "sign-ins" to AF_TEST_FIXTURES and run \`pnpm adminforge provision test-identities\`.`,
    );
const { graph } = provisionerClients({ env, writeEnv: () => undefined, out: () => undefined }, settings);
const screenshot = process.argv[2];
const MY_APPS = 'https://myapplications.microsoft.com/';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Up to `tries` attempts: Entra can take a minute to accept a sign-in after an account is enabled. */
async function retrying<T>(what: string, tries: number, fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`  … ${what}: not yet (${i}/${tries}), trying again in 30 s`);
      await wait(30_000);
    }
  }
}

/** Fills the UPN and a password on Microsoft's sign-in page; resolves with the page text after the password step. */
async function submitPassword(page: Page, upn: string, password: string): Promise<string> {
  await page.goto(MY_APPS);
  await page.locator('input[name="loginfmt"]').fill(upn);
  await page.locator('#idSIButton9').click();
  await page.locator('input[name="passwd"]').fill(password);
  await page.locator('#idSIButton9').click();
  await page.waitForTimeout(5_000);
  return (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).replace(/\s+/g, ' ');
}

/** Enables one account for its sign-in, or stops: never sign in as an account that isn't the fixture's own. */
async function enableOnly(n: 1 | 2) {
  const r = await setSignInAccountsEnabled(graph, [one!, two!], true, n);
  if (r.refused.length || r.missing.length)
    throw new Error(
      `${[...r.refused, ...r.missing].join(', ')}: ${r.refused.length ? 'has no sign-ins marker' : 'does not exist'} — not signing in; run \`pnpm adminforge provision test-identities\`.`,
    );
}

/** Interrupted (Ctrl-C, a stopped job): disable both before exiting. */
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`${signal}: disabling the sign-in accounts before exiting…`);
    void setSignInAccountsEnabled(graph, [one!, two!], false)
      .catch(() =>
        console.error('✗ could not disable them — run `pnpm adminforge provision test-identities --disable`'),
      )
      .finally(() => process.exit(130));
  });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = false;
let page: Page | undefined;
try {
  // 1. A successful sign-in with MFA.
  await enableOnly(1);
  await retrying('successful sign-in', 3, async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto(MY_APPS);
    const { registeredTotp } = await signInWithEntra(page, {
      upn: one!.upn,
      password: env[one!.passwordKey]!,
      totpSecret: env[one!.totpKey!]?.trim() || undefined,
      totpKey: one!.totpKey,
    });
    if (registeredTotp) env[one!.totpKey!] = registeredTotp;
    console.log(`✓ ${one!.displayName}: signed in${registeredTotp ? ' (MFA registered now)' : ''}`);
    await context.close();
  });
  await setSignInAccountsEnabled(graph, [one!, two!], false, 1);

  // 2. A wrong password.
  await enableOnly(2);
  await retrying('wrong-password sign-in', 3, async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    const text = await submitPassword(page, two!.upn, `${env[two!.passwordKey]!}-wrong`);
    await context.close();
    if (!/password is incorrect|incorrect password|AADSTS50126/i.test(text))
      throw new Error(
        `Entra did not refuse the wrong password as expected (page: "${mask(text).slice(0, 240)}").`,
      );
    console.log(`✓ ${two!.displayName}: wrong password refused`);
  });

  // 3. The real password while disabled (Entra refuses the account, the sign-in log records it).
  await setSignInAccountsEnabled(graph, [one!, two!], false, 2);
  // Disabling reaches sign-in after a minute or two.
  await wait(90_000);
  await retrying('disabled-account sign-in', 4, async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    const text = await submitPassword(page, two!.upn, env[two!.passwordKey]!);
    await context.close();
    if (!/locked|disabled|AADSTS50057/i.test(text))
      throw new Error(
        `Entra did not refuse the disabled account as expected (page: "${mask(text).slice(0, 240)}").`,
      );
    console.log(`✓ ${two!.displayName}: refused while disabled`);
  });
  console.log('Sign-in logs show these within minutes; usage and inactivity reports within a day.');
} catch (e) {
  failed = true;
  if (page)
    await page
      .screenshot({ path: liveOutFile(screenshot, 'generate-sign-ins-failure.png') })
      .catch(() => undefined);
  console.error(maskError(e), page ? `| last url: ${maskUrl(page.url())}` : '');
} finally {
  await browser.close();
  const { changed, refused } = await setSignInAccountsEnabled(graph, [one!, two!], false);
  console.log(`Sign-in accounts disabled again${changed ? ` (${changed} changed)` : ''}.`);
  if (refused.length) failed = true;
}
if (failed) process.exitCode = 1;
