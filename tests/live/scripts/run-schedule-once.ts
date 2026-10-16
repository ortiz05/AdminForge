// Live: run one schedule (or probes) once as the automation identity against the DEV database — the scheduler's own
// one-shot path (`Scheduler.runOnce`, `runProbe`), with email and Teams delivery suppressed or redirected so no real
// recipient gets anything. Prints statuses, reason codes and counts only.
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
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv, overlayEnvFilePath } from '@adminforge/config';
import { mask } from '../lib/mask';

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

const { RECIPIENT_KEY, SENDER_KEY, WEBHOOK_KEY } = await import('@adminforge/api/src/delivery/notifier');

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

const { loadConfig } = await import('@adminforge/api/src/config');
const { createContext } = await import('@adminforge/api/src/context');
const { createRunsModule } = await import('@adminforge/api/src/runs/module');
const { createSchedulesModule } = await import('@adminforge/api/src/schedules/module');
const { Scheduler } = await import('@adminforge/api/src/schedules/scheduler');
const { runProbe } = await import('@adminforge/api/src/probes/checks');
type Probe = import('@adminforge/schemas').Probe;

const say = (level: string) => (obj: object, msg: string) => {
  if (/No client info in response/.test(msg)) return; // MSAL, expected for app-only tokens
  const err = (obj as { err?: { message?: string } }).err?.message;
  process.stderr.write(`[${level}] ${mask(msg)}${err ? ` — ${mask(err)}` : ''}\n`);
};
const log = { info: () => undefined, warn: say('warn'), error: say('error') };

const config = loadConfig();
if (values.schedule && !config.DATABASE_URL)
  throw new Error('No DATABASE_URL in the env file: schedules need the dev database (`pnpm db:up`).');
const ctx = createContext(config, values['no-store'] ? { database: null } : {}, { warn: log.warn });
if (!ctx.automation) throw new Error('The automation identity is not configured in the env file.');

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
const delivery = {
  outbound: ctx.outbound,
  fetch: refuse,
  env: deliveryConfig,
  publicBaseUrl: config.PUBLIC_BASE_URL,
};
const runs = createRunsModule(ctx, { inProcessWorker: false, log });
const schedules = createSchedulesModule(ctx, runs, { inProcess: false, log, delivery });

console.log(
  `database: ${ctx.database ? 'dev (env file)' : 'none (--no-store)'} · identity: automation (${ctx.automation.credential}) · delivery: ${
    values.deliver === 'sender'
      ? `every recipient list is AF_MAIL_SENDER itself, Teams suppressed (${webhooks} webhook key(s) blanked)`
      : `suppressed (${recipients} recipient and ${webhooks} webhook key(s) blanked)`
  }`,
);

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
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
    const scheduler = new Scheduler({
      store: schedules.store,
      definitions: ctx.definitions,
      jobs: schedules.jobs,
      audit: ctx.audit,
      events: schedules.events,
      now: ctx.now,
      delivery,
      log,
    });
    const run = await scheduler.runOnce(values.schedule, `live-script:${process.env.USER ?? 'operator'}`);
    const r = (run.result ?? {}) as Record<string, unknown>;
    const counts = ['probes', 'feeds', 'ok', 'warn', 'crit', 'error', 'failed', 'skipped', 'new', 'updated']
      .filter((k) => typeof r[k] === 'number')
      .map((k) => `${k}=${r[k] as number}`);
    const artifacts =
      (r.artifacts as Array<{ format: string; rows: number; truncated: boolean }> | undefined) ?? [];
    console.log(
      `${values.schedule}: ${run.status}${counts.length ? ` (${counts.join(' ')})` : ''}${run.error ? ` — ${run.error.code}` : ''}`,
    );
    for (const a of artifacts)
      console.log(`  file ${a.format}: ${a.rows} row(s)${a.truncated ? ' (truncated)' : ''}`);
    for (const d of (r.delivery as Array<{ type: string; status: string }> | undefined) ?? [])
      console.log(`  delivery ${d.type}: ${d.status}`);
    type Line = { key: string; status: string; code: string; new?: number; updated?: number };
    for (const p of (r.results as Line[] | undefined) ?? [])
      console.log(
        `  ${pad(p.key, 48)} ${pad(p.status, 8)} ${pad(p.code, 20)}${typeof p.new === 'number' ? ` new=${p.new} updated=${p.updated ?? 0}` : ''}`,
      );
    if (typeof r.runStatus === 'string')
      console.log(`  playbook run (dev API worker): ${r.runStatus}${r.dryRun ? ' (dry run)' : ''}`);
    exitCode = run.status === 'succeeded' ? 0 : 1;
  } else {
    const all = await ctx.definitions.list('probe');
    for (const key of values.probe!) {
      const rec = all.find((x) => x.key === key);
      if (!rec) {
        console.log(`${pad(key, 48)} unknown probe`);
        exitCode = 1;
        continue;
      }
      const probe = rec.def as Probe;
      const o = await runProbe(rec.key, probe, schedules.probeDeps, {});
      const metric = o.metric === null ? '-' : `${Math.round(o.metric * 10) / 10} ${o.unit}`;
      console.log(
        `${pad(o.probeKey, 48)} ${pad(probe.check.kind, 20)} ${pad(o.status, 6)} ${pad(o.code, 20)} ${pad(metric, 16)} ${o.durationMs} ms`,
      );
      if (o.status === 'error' || o.status === 'crit') exitCode = 1;
      if (!values['no-store'] && ctx.database)
        await schedules.store
          .insertProbeResult({
            probeKey: rec.key,
            ts: o.ts,
            status: o.status,
            metric: o.metric,
            durationMs: o.durationMs,
            message: o.message.slice(0, 2000),
            details: o.details,
            scheduleRunId: null,
          })
          .catch((err: unknown) =>
            log.warn({ err: { message: (err as Error).message } }, 'probe result not stored'),
          );
    }
  }
} finally {
  await schedules.stop().catch(() => undefined);
  await runs.stop().catch(() => undefined);
  await ctx.events.close().catch(() => undefined);
  await ctx.definitions.close().catch(() => undefined);
  await ctx.database?.close().catch(() => undefined);
}
process.exit(exitCode);
