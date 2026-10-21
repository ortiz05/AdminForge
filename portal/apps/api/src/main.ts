import { buildApp } from './app';
import { loadConfig } from './config';
import { reclaimSpace } from './db/client';
import { assertDatabaseFile } from './db/file-check';
import { runMigrations } from './db/migrate';
import { applyRetention } from './housekeeping/retention';
import { onShutdownSignal } from './shutdown';

const HOUSEKEEPING_MS = 10 * 60_000;
/** History retention runs at most this often (it scans by age; cheap when there is nothing to delete). */
const RETENTION_EVERY_MS = 6 * 3_600_000;
let lastRetention = 0;

const config = loadConfig();
if (config.DATABASE_PATH) {
  // Before anything is written: production refuses an unsafe location (others can write it, a network file system).
  try {
    assertDatabaseFile(config.DATABASE_PATH, {
      production: config.NODE_ENV === 'production',
      warn: (msg) => process.stderr.write(`${JSON.stringify({ level: 40, msg })}\n`),
    });
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ level: 60, msg: (err as Error).message })}\n`);
    process.exit(1);
  }
  // One pod, `strategy: Recreate` (ADR-017): no older version has the file open, so the API brings the schema up to
  // date.
  await runMigrations(config.DATABASE_PATH);
}
const app = await buildApp(config);
const { ctx } = app;

async function housekeeping() {
  const now = ctx.now();
  try {
    await ctx.preauth.purge(now);
    await ctx.sessions.purge({ now, idleMinutes: config.SESSION_IDLE_MINUTES });
    ctx.database?.signals.prune(now);
    if (ctx.database && now.getTime() - lastRetention >= RETENTION_EVERY_MS) {
      lastRetention = now.getTime();
      const purged = await applyRetention(
        ctx.database.db,
        { artifacts: app.schedules.artifacts, audit: ctx.audit, now, news: app.schedules.news },
        {
          runDays: config.RETENTION_RUN_DAYS,
          scheduleRunDays: config.RETENTION_SCHEDULE_RUN_DAYS,
          probeDays: config.RETENTION_PROBE_DAYS,
          artifactDays: config.RETENTION_ARTIFACT_DAYS,
        },
      );
      const reclaimed = await reclaimSpace(ctx.database.sqlite);
      // Stopped at its time budget: the rest goes at the next housekeeping pass, not in six hours.
      if (purged.pending || reclaimed.pending) lastRetention = 0;
      app.log.info({ purged, reclaimed }, 'retention applied');
    }
  } catch (err) {
    app.log.warn({ err }, 'housekeeping failed');
  }
}
const timer = setInterval(() => void housekeeping(), HOUSEKEEPING_MS);
timer.unref();

// D-24: the stop has a deadline of its own, below the pod's terminationGracePeriodSeconds (shutdown.ts).
const shutdown = onShutdownSignal({
  close: async () => {
    clearInterval(timer);
    await app.close();
  },
  deadlineMs: config.SHUTDOWN_TIMEOUT_SECONDS * 1000,
  log: app.log,
  pending: () => ({ runs: app.runs.worker.activeRuns() }),
  exit: (code) => process.exit(code),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

await app.listen({ port: config.API_PORT, host: config.API_HOST });
app.log.info(
  { authMode: config.AUTH_MODE, dataMode: config.DATA_MODE, store: ctx.database ? 'sqlite' : 'memory' },
  'AdminForge API ready',
);
void housekeeping();
