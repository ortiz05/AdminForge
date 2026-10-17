// Live: a schedule that runs as its creator ("Run as: Me", ADR-014) end to end on a deployed AdminForge — the
// validation user creates a portal report schedule with `identity: { user: creator }`, signs in for it through Entra
// (the consent round trip: a fresh sign-in, auth_time checked), runs it now, checks the run succeeded and was executed
// as the creator (run and audit), downloads its file, then deletes the schedule and checks nothing can sign in for it
// any more.
//
// Usage (repository root; the validation user enabled — see tests/live/README.md):
//   PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 NODE_EXTRA_CA_CERTS=<caddy root.crt> \
//     pnpm exec tsx tests/live/scripts/check-user-schedule.ts [--report <id>] [--approver] [--needs-sign-in]
// --approver: also checks that another person (the approver fixture "AF Tester 2", Portal.Reader — enable it with
//   `provision test-identities --enable --approver`) sees the run but can't open its file.
// --needs-sign-in: also revokes the validation user's sign-in sessions (Graph revokeSignInSessions, as the
//   provisioner), runs the schedule again and checks it is skipped as "needs sign-in" — the grant's refresh token is
//   dead. It then signs in again to delete the schedule. Revoking ends every session of the validation user, so run
//   this last (Entra may ask that account to sign in again for a few minutes afterwards).
// Output: one line per check (✓ / ✗), statuses and counts only — no ids, UPNs or file contents. Exit code 1 on any ✗.
// Safety: read-only report, a schedule the script creates and always deletes (also when a check fails); the validation
// user's own delegated access; no write app, no arming.
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { provisionerClients } from '../../../portal/tools/cli/src/provision/clients';
import { provisionSettings } from '../../../portal/tools/cli/src/provision/settings';
import { openPublicSession } from '../lib/accuracy-session';
import { signInWithEntra, testApproverCredentials, testUserCredentials } from '../lib/entra-login';
import { why } from '../lib/mask';
import { createApiCall, type PortalSession } from '../lib/portal-session';

const { values } = parseArgs({
  options: {
    report: { type: 'string', default: 'identity.groups-without-owners' },
    approver: { type: 'boolean', default: false },
    'needs-sign-in': { type: 'boolean', default: false },
  },
});

const env = loadEnv(process.env, { admin: true });
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunsAs {
  kind: string;
  signIn?: string;
  canSignIn?: boolean;
}
interface ScheduleItem {
  key: string;
  runsAs?: RunsAs;
  enabled: boolean;
}
interface RunItem {
  id: string;
  status: string;
  artifact?: { href: string; size: number | null };
  error?: { code: string };
  reason?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'timeout', 'skipped', 'cancelled']);

/** Waits for a schedule run to finish (the host scheduler picks it up). */
async function settleRun(
  s: PortalSession,
  key: string,
  runId: string,
  minutes = 5,
): Promise<RunItem | undefined> {
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    const { status, json } = await s.api<{ items: RunItem[] }>(
      'GET',
      `/api/schedules/${encodeURIComponent(key)}/runs?limit=10`,
    );
    const run = status === 200 ? json.items.find((r) => r.id === runId) : undefined;
    if (run && TERMINAL.has(run.status)) return run;
    await sleep(5_000);
  }
  return undefined;
}

/** A second browser signed in as another fixture account, talking to the same deployed portal. */
async function openSessionAs(creds: ReturnType<typeof testUserCredentials>): Promise<PortalSession> {
  const base = (env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.AF_LIVE_INSECURE_TLS === '1' });
  const page = await context.newPage();
  await page.goto(`${base}/auth/login?returnTo=%2F`);
  await signInWithEntra(page, creds);
  await page.waitForURL((u) => u.toString().startsWith(base), { timeout: 60_000 });
  return {
    browser,
    context,
    page,
    base,
    api: createApiCall(context.request, base),
    close: () => browser.close(),
  };
}

/** Lets the schedule use the creator's access: the consent round trip through Entra (a fresh sign-in). */
async function signInForSchedule(s: PortalSession, key: string) {
  const { status, json } = await s.api<{ redirect?: string; error?: unknown }>(
    'POST',
    `/auth/schedule-consent?returnTo=${encodeURIComponent(`/schedules/${key}`)}`,
    { key },
  );
  if (!check(status === 200 && !!json.redirect, 'consent round trip starts', `${status}${why(json.error)}`))
    return;
  await s.page.goto(json.redirect!);
  await signInWithEntra(s.page, testUserCredentials(env));
  await s.page.waitForURL((u) => u.toString().startsWith(s.base), { timeout: 60_000 });
}

const getSchedule = (s: PortalSession, key: string) =>
  s.api<ScheduleItem & { error?: unknown }>('GET', `/api/schedules/${encodeURIComponent(key)}`);

async function runNow(s: PortalSession, key: string) {
  const { status, json } = await s.api<{ scheduleRunId?: string; error?: unknown }>(
    'POST',
    `/api/schedules/${encodeURIComponent(key)}/run`,
  );
  check(status === 202 && !!json.scheduleRunId, 'Run now accepted', `${status}${why(json.error)}`);
  return json.scheduleRunId;
}

let s = await openPublicSession();
let key: string | undefined;
let reopened = false;
const started = new Date().toISOString();
try {
  const ids = await s.api<{ user: boolean }>('GET', '/api/schedules/identities');
  check(ids.status === 200 && ids.json.user === true, '"Me" is offered as a run-as choice');

  // Leftovers of an interrupted earlier run (titles this script uses), deleted first.
  const list = await s.api<{ items: Array<ScheduleItem & { title?: string; source?: string }> }>(
    'GET',
    '/api/schedules',
  );
  const leftovers = (list.json.items ?? []).filter(
    (i) => i.source === 'portal' && (i.title ?? '').startsWith('AF-Test live check: run as me'),
  );
  for (const l of leftovers) await s.api('DELETE', `/api/schedules/${encodeURIComponent(l.key)}`);
  if (leftovers.length) console.log(`· deleted ${leftovers.length} leftover check schedule(s)`);

  // 1. A portal report schedule that runs as its creator (the same request the report schedule form sends).
  const create = (title: string) =>
    s.api<ScheduleItem & { error?: unknown }>('POST', '/api/schedules', {
      title,
      cron: '0 5 * * 1',
      timezone: 'UTC',
      enabled: true,
      identity: { user: 'creator' },
      job: { kind: 'report', ref: values.report, format: 'csv', retain: 1 },
    });

  // A run before anyone signed in for it doesn't run (needs_sign_in, never as someone else). Its own schedule: Run now
  // is limited to once every 15 minutes per schedule.
  const pre = await create('AF-Test live check: run as me, not signed in');
  if (check(pre.status === 201, 'a second "Me" schedule created', String(pre.status))) {
    const preRun = await runNow(s, pre.json.key);
    const r = preRun ? await settleRun(s, pre.json.key, preRun) : undefined;
    check(
      (r?.status === 'failed' || r?.status === 'skipped') && r?.error?.code === 'needs_sign_in',
      'a run before signing in doesn’t run (needs sign-in)',
      `${r?.status ?? 'no result'}${why(r?.error)}`,
    );
    const del = await s.api('DELETE', `/api/schedules/${encodeURIComponent(pre.json.key)}`);
    check(del.status === 204, 'that schedule deleted', String(del.status));
  }

  const created = await create('AF-Test live check: run as me');
  if (
    !check(created.status === 201, 'schedule created as "Me"', `${created.status}${why(created.json.error)}`)
  )
    throw new Error('stop');
  key = created.json.key;
  check(created.json.runsAs?.kind === 'user', 'it runs as its creator');
  check(
    created.json.runsAs?.signIn === 'not_signed_in',
    'not signed in yet',
    created.json.runsAs?.signIn ?? '',
  );

  // 2. The creator signs in for it.
  await signInForSchedule(s, key);
  const after = await getSchedule(s, key);
  check(
    after.json.runsAs?.signIn === 'signed_in',
    'signed in for the schedule',
    after.json.runsAs?.signIn ?? '',
  );

  // --needs-sign-in skips 3–5: Run now is limited to once every 15 minutes per schedule, and step 6 needs its run.
  if (!values['needs-sign-in']) {
    // 3. Run now: succeeds with the creator's own access and writes the file.
    const runId = await runNow(s, key);
    const run = runId ? await settleRun(s, key, runId) : undefined;
    check(
      run?.status === 'succeeded',
      'the run succeeded',
      `${run?.status ?? 'no result'}${why(run?.error)}`,
    );
    if (run?.artifact) {
      const file = await s.context.request.get(`${s.base}${run.artifact.href}`);
      const body = await file.body();
      check(
        file.status() === 200 && body.length > 0,
        'the creator can open its file',
        `${file.status()}, ${body.length} bytes`,
      );
    } else check(false, 'the run has a file');

    // 4. The audit log says who it ran as (Portal.Admin can read it; the validation user is one).
    const audit = await s.api<{
      items: Array<{ action: string; targetId?: string | null; details?: Record<string, unknown> }>;
    }>('GET', `/api/audit?action=schedule.run&from=${encodeURIComponent(started)}&limit=50`);
    const entry = audit.json.items?.find((e) => e.targetId === key);
    const executedAs = String(entry?.details?.executedAs ?? '');
    check(!!entry, 'the run is audited');
    check(
      /own access|their own|creator/i.test(executedAs) || executedAs.includes('@'),
      'audited as executed by the creator',
      executedAs.includes('@') ? '(the creator’s sign-in name)' : executedAs,
    );

    // 5. Someone else sees the run but not the file (its contents are what the creator can see).
    if (values.approver) {
      const other = await openSessionAs(testApproverCredentials(env));
      try {
        const runs = await other.api<{ items: RunItem[] }>(
          'GET',
          `/api/schedules/${encodeURIComponent(key)}/runs?limit=10`,
        );
        const seen = runs.json.items?.find((r) => r.id === runId);
        check(!!seen && !seen.artifact, 'another person sees the run without a file link');
        if (runId) {
          const file = await other.context.request.get(`${other.base}/api/artifacts/${runId}`);
          check(
            file.status() === 403 || file.status() === 404,
            'another person can’t open its file',
            String(file.status()),
          );
        }
      } finally {
        await other.close();
      }
    }
  }

  // 6. Needs sign-in: revoke the creator's sessions, so the schedule's refresh token is dead.
  if (values['needs-sign-in']) {
    const settings = provisionSettings(env);
    const { graph } = provisionerClients(
      { env, writeEnv: () => undefined, out: () => undefined } as never,
      settings,
    );
    await graph.request({
      method: 'POST',
      path: `/users/${encodeURIComponent(env.AF_TEST_USER_UPN!)}/revokeSignInSessions`,
    });
    console.log('· revoked the validation user’s sign-in sessions');
    // Revocation reaches Entra's token service within a minute or two; one retry after the 15-minute Run now limit.
    let refused: RunItem | undefined;
    for (let attempt = 1; attempt <= 2 && !refused; attempt++) {
      await sleep(attempt === 1 ? 120_000 : 16 * 60_000);
      // The revoked session may no longer read roles: sign in afresh (new tokens, a separate partition from the
      // schedule's grant, which stays revoked).
      await s.close();
      s = await openPublicSession();
      reopened = true;
      const id = await runNow(s, key);
      const r = id ? await settleRun(s, key, id) : undefined;
      if ((r?.status === 'skipped' || r?.status === 'failed') && r?.error?.code === 'needs_sign_in')
        refused = r;
      else console.log(`· attempt ${attempt}: ${r?.status ?? 'no result'} (revocation not seen yet)`);
    }
    const skipped = refused;
    check(
      !!skipped,
      'after revocation the run doesn’t run (needs sign-in)',
      skipped ? `${skipped.status}` : '',
    );
    const state = await getSchedule(s, key);
    check(
      state.json.runsAs?.signIn === 'needs_sign_in',
      'the schedule shows "Needs sign-in"',
      state.json.runsAs?.signIn ?? `${state.status}`,
    );
  }
} catch (err) {
  if ((err as Error).message !== 'stop') check(false, 'unexpected error', why({ code: (err as Error).name }));
} finally {
  // 7. Delete it — as a fresh session when the old one was revoked — and check nothing can sign in for it any more.
  if (key) {
    if (values['needs-sign-in'] && !reopened) {
      await s.close();
      s = await openPublicSession();
    }
    const del = await s.api('DELETE', `/api/schedules/${encodeURIComponent(key)}`);
    check(del.status === 204, 'schedule deleted', String(del.status));
    const consent = await s.api<{ error?: { code?: string } }>('POST', '/auth/schedule-consent', { key });
    check(
      consent.status === 404 || consent.status === 409,
      'a deleted schedule can’t be signed in for',
      `${consent.status}${why(consent.json?.error)}`,
    );
  }
  await s.close();
}
process.exitCode = failed ? 1 : 0;
