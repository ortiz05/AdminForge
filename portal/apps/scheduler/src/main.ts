import { parseArgs } from 'node:util';
import { createContext, loadConfig, safeLogFields } from '@adminforge/api/tooling';
import { createRunsModule, createSchedulesModule } from '@adminforge/api/tooling/scheduler';
import { openOneShot, PROBE_HEADER, probeLine, probeSummary, scheduleRunLines } from './one-shot';

/**
 * AdminForge scheduler service (R6, ADR-011): runs content schedules on this host as the automation identity.
 * Only one scheduler is active at a time (Postgres advisory lock); start a second one as a hot standby.
 *
 *   node dist/main.js                       run the service (needs DATABASE_URL)
 *   node dist/main.js --once                run every probe once and print statuses (no tenant data is printed)
 *   node dist/main.js --probe <key> …       run the named probes once (one --probe per key)
 *   node dist/main.js --schedule <key>      run one schedule now (as a manual run, audited) and exit
 *   add --no-store to one-shots to skip writing probe_results
 *
 * The one-shots are `one-shot.ts` (shared with tests/live/scripts/run-schedule-once.ts). API modules come only from
 * `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler`. In development the API can run the scheduler
 * in-process instead: SCHEDULER_IN_PROCESS=true.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const write = (level: Level) => (obj: object, msg: string) => {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    role: 'scheduler',
    msg,
    ...safeLogFields(obj),
  });
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
    'Usage: adminforge-scheduler [--once | --probe <key> [--probe <key>…] | --schedule <key>] [--no-store]\n',
  );
  process.exit(0);
}

const config = loadConfig();
const out = (line: string) => process.stdout.write(`${line}\n`);

if (values.schedule || values.once || values.probe?.length) {
  const oneShot = openOneShot(config, { log, noStore: values['no-store'] });
  let code = 0;
  try {
    if (values.schedule) {
      const run = await oneShot.runSchedule(values.schedule, `cli:${process.env.USER ?? 'operator'}`);
      for (const line of scheduleRunLines(values.schedule, run)) out(line);
      code = run.status === 'succeeded' ? 0 : 1;
    } else {
      const result = await oneShot.runProbes(values.probe);
      if (result.missing.length) log.warn({ missing: result.missing }, 'unknown probes skipped');
      out(PROBE_HEADER);
      for (const r of result.results) out(probeLine(r));
      out(`\n${probeSummary(result)}`);
    }
  } catch (err) {
    log.error(
      { err: { message: (err as Error).message } },
      values.schedule ? 'schedule run failed' : 'probe run failed',
    );
    code = 1;
  }
  await oneShot.close();
  process.exit(code);
}

if (!config.DATABASE_URL) {
  log.error({}, 'The scheduler needs DATABASE_URL (schedules, runs and the leader lock live in Postgres).');
  process.exit(1);
}

const ctx = createContext(config, {}, { warn: log.warn });
// Scheduled playbook runs are enqueued for the run worker (ROLE=worker); this process does not execute them.
const runs = createRunsModule(ctx, { inProcessWorker: false, log });
const schedules = createSchedulesModule(ctx, runs, { inProcess: true, log });

async function close(code: number): Promise<never> {
  await schedules.stop().catch(() => undefined);
  await runs.stop().catch(() => undefined);
  await ctx.events.close().catch(() => undefined);
  await ctx.definitions.close().catch(() => undefined);
  await ctx.database?.close().catch(() => undefined);
  process.exit(code);
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
