import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import { componentStates } from '../health/heartbeat';

/** Liveness and readiness. Not rate limited (monitors poll them). */
export function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { config: { rateLimit: false } }, async () => {
    if (!ctx.database) return { status: 'ok', checks: { db: 'memory' } };
    try {
      await ctx.database.ping();
    } catch {
      throw new AppError(503, 'not_ready', 'The database is not reachable.', {
        hint: 'Check that Postgres is running (pnpm db:up) and DATABASE_URL is correct.',
      });
    }
    // The API is ready either way (200); `degraded` tells monitors that runs or schedules aren't being processed.
    const components = await componentStates(ctx.database.db, ctx.now()).catch(() => null);
    const degraded = !components || Object.values(components).some((s) => s !== 'ok');
    return { status: degraded ? 'degraded' : 'ok', checks: { db: 'ok', ...(components ?? {}) } };
  });
}
