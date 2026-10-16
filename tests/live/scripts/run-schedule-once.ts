// Live: run one schedule (or probes) once as the automation identity against the DEV database — the scheduler
// service's own one-shot module (portal/apps/scheduler/src/one-shot.ts: `Scheduler.runOnce`, `runProbe`, the same
// status lines), with email and Teams delivery suppressed or redirected so no real recipient gets anything. This
// script adds only the safety guards below and the delivery override.
//
// Usage (from the repository root, dev env file; never with ADMINFORGE_ENV_OVERLAY=host):
//   pnpm exec tsx tests/live/scripts/run-schedule-once.ts --schedule <key> [--deliver none|sender]
//   pnpm exec tsx tests/live/scripts/run-schedule-once.ts --probe <key> [--probe <key>…] [--no-store]
//
// --deliver none (default): every recipient list (AF_…_RECIPIENTS / _EMAIL / _ALERTS, approvals included) and every
//   Teams webhook (AF_…_WEBHOOK…) is blanked for this process, so delivery reports `not_configured`.
// --deliver sender: every recipient list a schedule names (configured or not) is AF_MAIL_SENDER itself — the report
//   mailbox sends to itself, no person receives mail; Teams webhooks are blanked. Needs AF_MAIL_SENDER.
// Refused: playbook schedules (they would enqueue a real run for the dev API's worker — use run-playbook.ts, which
// previews first), DATABASE_URL from the process environment, and a dev database that is also the host services'
// (the `host` overlay resolving to the same DATABASE_URL). Database URLs are compared, never printed.
// Output: a line on database, identity and delivery; then the run status, reason codes, file row counts and delivery
//   statuses, or one line per probe (key, kind, status, code, metric) — log lines on stderr are masked (lib/mask.ts).
//   Exit code 1 unless the schedule succeeded / every probe is ok or warn.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv, overlayEnvFilePath } from '@adminforge/config';
import { mask, maskError } from '../lib/mask';

const { values } = parseArgs({
  options: {
    schedule: { type: 'string' },
    probe: { type: 'string', multiple: true },
    deliver: { type: 'string', default: 'none' },
    'no-store': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});
const usage =
  'usage: run-schedule-once.ts --schedule <key> [--deliver none|sender] | --probe <key>… [--no-store]';
if (!values.schedule === !values.probe?.length) throw new Error(usage);
if (values.deliver !== 'none' && values.deliver !== 'sender') throw new Error(usage);

// The dev database only: the host services use the `host` overlay (<env>.host.env) and their own database.
const usesDatabase = !!values.schedule || !values['no-store'];
const overlay = process.env.ADMINFORGE_ENV_OVERLAY;
if (overlay === 'host')
  throw new Error(
    'Refusing ADMINFORGE_ENV_OVERLAY=host: that is the host services’ database. Run against the dev database (unset it).',
  );
if (usesDatabase && process.env.DATABASE_URL !== undefined)
  throw new Error(
    'Refusing DATABASE_URL from the process environment: this script uses only the dev env file’s database. Unset it.',
  );
const devDatabase = loadEnv({ ...process.env, ADMINFORGE_ENV_OVERLAY: '' }).DATABASE_URL;
if (usesDatabase && overlay && devDatabase !== loadEnv().DATABASE_URL)
  throw new Error(
    `Refusing ADMINFORGE_ENV_OVERLAY=${overlay}: it points at another database than the dev env file.`,
  );
// Where host services are configured, their database must not be this one (they would race this run's jobs).
const hostEnv = { ...process.env, ADMINFORGE_ENV_OVERLAY: 'host' };
const hostFile = overlayEnvFilePath(hostEnv);
if (
  usesDatabase &&
  hostFile &&
  existsSync(hostFile) &&
  loadEnv().DATABASE_URL &&
  loadEnv(hostEnv).DATABASE_URL === loadEnv().DATABASE_URL
)
  throw new Error(
    'Refusing: the database this script would use is also the host services’ database (the host overlay resolves to the same DATABASE_URL). Give the services their own database in <env>.host.env (portal/deploy).',
  );

// API and scheduler modules load only after the guards (and before the configuration is read).
const { loadConfig, RECIPIENT_KEY, SENDER_KEY, WEBHOOK_KEY } = await import('@adminforge/api/tooling');
const { openOneShot, PROBE_HEADER, probeFailed, probeLine, probeSummary, scheduleRunLines } =
  await import('@adminforge/scheduler/one-shot');

// Delivery keys are rewritten in process.env before anything reads the configuration (process.env wins over the files).
const base = loadEnv();
const sender = base[SENDER_KEY]?.trim();
if (values.deliver === 'sender' && !sender)
  throw new Error(
    '--deliver sender needs AF_MAIL_SENDER in the env file (the mailbox reports are sent from).',
  );
let recipients = 0;
let webhooks = 0;
for (const key of Object.keys(base)) {
  if (WEBHOOK_KEY.test(key)) {
    process.env[key] = '';
    webhooks++;
  } else if (RECIPIENT_KEY.test(key)) {
    process.env[key] = values.deliver === 'sender' ? sender! : '';
    recipients++;
  }
}

const say = (level: string) => (obj: object, msg: string) => {
  if (/No client info in response/.test(msg)) return; // MSAL, expected for app-only tokens
  const err = (obj as { err?: unknown }).err;
  process.stderr.write(`[${level}] ${mask(msg)}${err ? ` — ${maskError(err)}` : ''}\n`);
};
const log = { info: () => undefined, warn: say('warn'), error: say('error') };

const config = loadConfig();
if (values.schedule && !config.DATABASE_URL)
  throw new Error('No DATABASE_URL in the env file: schedules need the dev database (`pnpm db:up`).');

// Teams is never posted from here, whatever the configuration says.
const refuse: typeof fetch = async () => {
  throw new Error('Teams delivery is suppressed in run-schedule-once');
};
// What delivery reads for `${ env.X }`: the sender; with --deliver sender every recipient list (configured or not)
// is the sender itself; webhooks are never resolved.
const deliveryConfig = new Proxy({} as Record<string, string | undefined>, {
  get: (_t, key) =>
    key === SENDER_KEY
      ? sender
      : typeof key === 'string' && RECIPIENT_KEY.test(key) && values.deliver === 'sender'
        ? sender
        : undefined,
});
// The override reaches both the jobs' report delivery and the scheduler's failure/success notifications; email goes
// through the process's own outbound executor as the automation identity.
const oneShot = openOneShot(config, {
  log,
  noStore: values['no-store'],
  delivery: { fetch: refuse, env: deliveryConfig },
});
const { ctx, schedules } = oneShot;
if (!ctx.automation) {
  await oneShot.close();
  throw new Error('The automation identity is not configured in the env file.');
}

console.log(
  `database: ${ctx.database ? 'dev (env file)' : 'none (--no-store)'} · identity: automation (${ctx.automation.credential}) · delivery: ${
    values.deliver === 'sender'
      ? `every recipient list is AF_MAIL_SENDER itself, Teams suppressed (${webhooks} webhook key(s) blanked)`
      : `suppressed (${recipients} recipient and ${webhooks} webhook key(s) blanked)`
  }`,
);

let exitCode = 0;
try {
  if (values.schedule) {
    // Playbook schedules would enqueue a real (possibly write) run for the dev API's worker: refused here.
    const inContent = (await ctx.definitions.list('schedule')).find((x) => x.key === values.schedule);
    const stored = ctx.database ? await schedules.store.getSchedule(values.schedule) : undefined;
    const kinds = [
      (inContent?.def as { job?: { kind?: string } } | undefined)?.job?.kind,
      stored?.definition.job.kind,
    ];
    if (kinds.includes('playbook'))
      throw new Error(
        `Refusing ${values.schedule}: it runs a playbook. Run the playbook with tests/live/scripts/run-playbook.ts (preview first) instead.`,
      );
    const run = await oneShot.runSchedule(values.schedule, `live-script:${process.env.USER ?? 'operator'}`);
    for (const line of scheduleRunLines(values.schedule, run)) console.log(line);
    exitCode = run.status === 'succeeded' ? 0 : 1;
  } else {
    const result = await oneShot.runProbes(values.probe);
    console.log(PROBE_HEADER);
    for (const key of result.missing) console.log(`${key.padEnd(48)} unknown probe`);
    for (const r of result.results) console.log(probeLine(r));
    console.log(probeSummary(result));
    if (result.missing.length || result.results.some((r) => probeFailed(r.outcome))) exitCode = 1;
  }
} catch (err) {
  console.error(`FAILED: ${maskError(err)}`);
  exitCode = 1;
} finally {
  await oneShot.close();
}
process.exit(exitCode);
