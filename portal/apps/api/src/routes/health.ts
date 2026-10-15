import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { AppError } from '../errors';

/** Liveness and readiness. Not rate limited (monitors poll them). */
export function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { config: { rateLimit: false } }, async () => {
    if (!ctx.database) return { status: 'ok', checks: { db: 'memory' } };
    try {
      await ctx.database.ping();
    } catch {
      throw new AppError(503, 'not_ready', 'The database is not reachable.', { hint: 'Check that Postgres is running (pnpm db:up) and DATABASE_URL is correct.' });
    }
    return { status: 'ok', checks: { db: 'ok' } };
  });
}
