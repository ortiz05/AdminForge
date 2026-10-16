import { buildApp } from './app';
import { loadConfig } from './config';
import { applyRetention } from './housekeeping/retention';

const HOUSEKEEPING_MS = 10 * 60_000;
/** History retention runs at most this often (it scans by age; cheap when there is nothing to delete). */
const RETENTION_EVERY_MS = 6 * 3_600_000;
let lastRetention = 0;

const config = loadConfig();
const app = await buildApp(config);
const { ctx } = app;

async function housekeeping() {
  const now = ctx.now();
  try {
    await ctx.preauth.purge(now);
    await ctx.sessions.purge({ now, idleMinutes: config.SESSION_IDLE_MINUTES });
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
      app.log.info({ purged }, 'retention applied');
    }
  } catch (err) {
    app.log.warn({ err }, 'housekeeping failed');
  }
}
const timer = setInterval(() => void housekeeping(), HOUSEKEEPING_MS);
timer.unref();

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ port: config.API_PORT, host: config.API_HOST });
app.log.info(
  { authMode: config.AUTH_MODE, dataMode: config.DATA_MODE, store: ctx.database ? 'postgres' : 'memory' },
  'AdminForge API ready',
);
void housekeeping();
