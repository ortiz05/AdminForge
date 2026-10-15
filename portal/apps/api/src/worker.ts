import { loadConfig } from './config';
import { createContext } from './context';
import { createRunsModule } from './runs/module';

/**
 * Worker process (ROLE=worker, same image as the API, §4.2): consumes the pg-boss run queue and executes playbook and
 * runbook steps with the engine. Needs DATABASE_URL (runs, sessions and the token cache live in Postgres).
 * In development the API can run the worker in-process instead: RUN_WORKER_IN_PROCESS=true.
 *
 *   ROLE=worker node dist/worker.js        (tsx src/worker.ts in development)
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const write = (level: Level) => (obj: object, msg: string) => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), role: 'worker', msg, ...obj });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};
const log = { info: write('info'), warn: write('warn'), error: write('error') };

const config = loadConfig();
if (!config.DATABASE_URL) {
  log.error({}, 'The run worker needs DATABASE_URL (runs and sessions live in Postgres).');
  process.exit(1);
}
const concurrency = config.RUN_WORKER_CONCURRENCY;
const ctx = createContext(config, {}, { warn: log.warn });
// serveSecrets: false — this process only publishes show-once secrets (sealed NOTIFY) to the API process(es).
const runs = createRunsModule(ctx, { inProcessWorker: true, workerConcurrency: concurrency, serveSecrets: false, log });
await runs.start();
log.info({ concurrency, queue: runs.queue.kind, authMode: config.AUTH_MODE, dataMode: config.DATA_MODE }, 'AdminForge run worker ready');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    runs
      .stop()
      .then(() => ctx.definitions.close())
      .then(() => ctx.database?.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}
