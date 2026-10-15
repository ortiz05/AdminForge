import { parseArgs } from 'node:util';
import { loadConfig } from '@adminforge/api/src/config';
import { createContext } from '@adminforge/api/src/context';
import { runProbe, type ProbeOutcome } from '@adminforge/api/src/probes/checks';
import { createRunsModule } from '@adminforge/api/src/runs/module';
import { createSchedulesModule } from '@adminforge/api/src/schedules/module';
import type { Probe } from '@adminforge/schemas';
// Type-only: the API's FastifyRequest augmentation (request.session), needed when this package type-checks API modules.
import type {} from '@adminforge/api/src/auth/session-plugin';

/**
 * AdminForge scheduler service (R6, ADR-011): runs content schedules on this host as the automation identity.
 * Only one scheduler is active at a time (Postgres advisory lock); start a second one as a hot standby.
 *
 *   node dist/main.js                       run the service (needs DATABASE_URL)
 *   node dist/main.js --once                run every probe once and print statuses (no tenant data is printed)
 *   node dist/main.js --probe <key> …       run the named probes once
 *   node dist/main.js --schedule <key>      run one schedule now (as a manual run, audited) and exit
 *   add --no-store to one-shots to skip writing probe_results
 *
 * In development the API can run the scheduler in-process instead: SCHEDULER_IN_PROCESS=true.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const write = (level: Level) => (obj: object, msg: string) => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), role: 'scheduler', msg, ...obj });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};
const warn = write('warn');
// MSAL logs "No client info in response" for every client-credential token; it is expected for app-only tokens.
const log = {
  info: write('info'),
  warn: (obj: object, msg: string) => (/No client info in response/.test(msg) ? undefined : warn(obj, msg)),
  error: write('error'),
};

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    probe: { type: 'string', multiple: true },
    schedule: { type: 'string' },
    'no-store': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    'Usage: adminforge-scheduler [--once | --probe <key>… | --schedule <key>] [--no-store]\n',
  );
  process.exit(0);
}

const config = loadConfig();
const oneShot = values.once || !!values.probe?.length || !!values.schedule;
if (!oneShot && !config.DATABASE_URL) {
  log.error({}, 'The scheduler needs DATABASE_URL (schedules, runs and the leader lock live in Postgres).');
  process.exit(1);
}

const ctx = createContext(config, values['no-store'] ? { database: null } : {}, { warn: log.warn });
// Scheduled playbook runs are enqueued for the run worker (ROLE=worker); this process does not execute them.
const runs = createRunsModule(ctx, { inProcessWorker: false, log });
const schedules = createSchedulesModule(ctx, runs, { inProcess: !oneShot, log });

async function close(code: number): Promise<never> {
  await schedules.stop().catch(() => undefined);
  await runs.stop().catch(() => undefined);
  await ctx.events.close().catch(() => undefined);
  await ctx.definitions.close().catch(() => undefined);
  await ctx.database?.close().catch(() => undefined);
  process.exit(code);
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** One line per probe: key, kind, status, reason code, metric — never messages or details (they can hold tenant data). */
function printOutcome(o: ProbeOutcome, kind: string) {
  const metric = o.metric === null ? '-' : `${Math.round(o.metric * 10) / 10} ${o.unit}`;
  process.stdout.write(
    `${pad(o.probeKey, 48)} ${pad(kind, 20)} ${pad(o.status, 6)} ${pad(o.code, 20)} ${pad(metric, 16)} ${o.durationMs} ms\n`,
  );
}

if (values.schedule) {
  try {
    // A one-shot needs a scheduler object (not leadership): build one on the same module pieces.
    const { Scheduler } = await import('@adminforge/api/src/schedules/scheduler');
    const scheduler = new Scheduler({
      store: schedules.store,
      definitions: ctx.definitions,
      jobs: schedules.jobs,
      audit: ctx.audit,
      events: schedules.events,
      now: ctx.now,
      log,
    });
    const run = await scheduler.runOnce(values.schedule, `cli:${process.env.USER ?? 'operator'}`);
    const r = run.result ?? {};
    const counts = ['probes', 'ok', 'warn', 'crit', 'error']
      .filter((k) => typeof r[k] === 'number')
      .map((k) => `${k}=${r[k] as number}`);
    process.stdout.write(
      `${values.schedule}: ${run.status}${counts.length ? ` (${counts.join(' ')})` : ''}${run.error ? ` — ${run.error.code}` : ''}\n`,
    );
    for (const p of (r.results as Array<{ key: string; status: string; code: string }> | undefined) ?? [])
      process.stdout.write(`  ${pad(p.key, 48)} ${pad(p.status, 6)} ${p.code}\n`);
    await close(run.status === 'succeeded' ? 0 : 1);
  } catch (err) {
    log.error({ err: { message: (err as Error).message } }, 'schedule run failed');
    await close(1);
  }
}

if (values.once || values.probe?.length) {
  const all = await ctx.definitions.list('probe');
  const wanted = values.probe?.length ? all.filter((r) => values.probe!.includes(r.key)) : all;
  const missing = (values.probe ?? []).filter((k) => !all.some((r) => r.key === k));
  if (missing.length) log.warn({ missing }, 'unknown probes skipped');
  const counts: Record<string, number> = { ok: 0, warn: 0, crit: 0, error: 0 };
  process.stdout.write(
    `${pad('probe', 48)} ${pad('kind', 20)} ${pad('status', 6)} ${pad('code', 20)} ${pad('metric', 16)} duration\n`,
  );
  for (const rec of wanted.sort((a, b) => a.key.localeCompare(b.key))) {
    const probe = rec.def as Probe;
    const o = await runProbe(rec.key, probe, schedules.probeDeps, {});
    counts[o.status] = (counts[o.status] ?? 0) + 1;
    printOutcome(o, probe.check.kind);
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
          log.warn({ err: { message: (err as Error).message } }, 'could not store the probe result'),
        );
  }
  process.stdout.write(
    `\n${wanted.length} probes: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}\n`,
  );
  await close(0);
}

await runs.queue
  .start()
  .catch((err: unknown) =>
    log.warn(
      { err: { message: (err as Error).message } },
      'run queue unavailable; playbook schedules will fail until it is',
    ),
  );
await schedules.start();
log.info(
  {
    concurrency: config.SCHEDULER_CONCURRENCY,
    authMode: config.AUTH_MODE,
    dataMode: config.DATA_MODE,
    automation: ctx.automation ? ctx.automation.credential : 'not configured',
  },
  'AdminForge scheduler ready (standing by for the leader lock)',
);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down (letting running jobs finish)');
    void close(0);
  });
}
