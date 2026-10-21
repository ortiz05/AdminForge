import { parseArgs } from 'node:util';
import { loadConfig, safeLogFields } from '@adminforge/api/tooling';
import { openOneShot, PROBE_HEADER, probeLine, probeSummary, scheduleRunLines } from './one-shot';

/**
 * AdminForge scheduler one-shots (R6, ADR-011). The scheduler itself runs inside the API process (ADR-016: one process
 * owns the SQLite file); these commands run beside it, against the same DATABASE_PATH:
 *
 *   node dist/main.js --once                run every probe once and print statuses (no tenant data is printed)
 *   node dist/main.js --probe <key> …       run the named probes once (one --probe per key)
 *   node dist/main.js --schedule <key>      run one schedule now (as a manual run, audited) and exit
 *   add --no-store to one-shots to skip writing probe_results (no database: no change is made either)
 *
 * A `--schedule` run that starts a playbook queues it; the API's run worker picks it up. The one-shots are
 * `one-shot.ts` (shared with tests/live/scripts/run-schedule-once.ts). API modules come only from
 * `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler`.
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

const USAGE =
  'Usage: adminforge-scheduler (--once | --probe <key> [--probe <key>…] | --schedule <key>) [--no-store]\n';
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const config = loadConfig();
const out = (line: string) => process.stdout.write(`${line}\n`);

if (!values.schedule && !values.once && !values.probe?.length) {
  process.stderr.write(
    `${USAGE}The scheduler service runs inside the API process now (ADR-016); this command only runs one-shots.\n`,
  );
  process.exit(2);
}

const oneShot = openOneShot(config, { log, noStore: values['no-store'] });
let code = 0;
try {
  if (values.schedule) {
    const run = await oneShot.runSchedule(values.schedule, `cli:${process.env.USER ?? 'operator'}`);
    for (const line of scheduleRunLines(values.schedule, run)) out(line);
    code = run.status === 'succeeded' ? 0 : 1;
  } else {
    const result = await oneShot.runProbes(values.probe, `cli:${process.env.USER ?? 'operator'}`);
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
