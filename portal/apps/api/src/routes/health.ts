import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import { componentStates } from '../health/heartbeat';

/** /readyz answers from a cached state at most this old: callers can't turn it into database load. */
export const READY_CACHE_MS = 5_000;
/** Per client address; monitors poll every few seconds at most (the portal-readiness probe every 5 minutes). */
export const READYZ_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

type Readiness =
  { ready: true; body: { status: 'ok' | 'degraded'; checks: Record<string, string> } } | { ready: false };

/** Liveness and readiness. /healthz touches nothing and isn't rate limited; /readyz is cached and rate limited. */
export function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  const compute = async (): Promise<Readiness> => {
    if (!ctx.database) return { ready: true, body: { status: 'ok', checks: { db: 'memory' } } };
    try {
      await ctx.database.ping();
    } catch (err) {
      // Once per refresh (not per caller): the reason is for administrators, never in the public answer.
      app.log.warn(
        { err: { name: (err as Error).name } },
        'not ready: the database is not reachable (is Postgres running, and is DATABASE_URL correct?)',
      );
      return { ready: false };
    }
    // The API is ready either way (200); `degraded` tells monitors that runs or schedules aren't being processed.
    const components = await componentStates(ctx.database.db, ctx.now()).catch(() => null);
    const degraded = !components || Object.values(components).some((s) => s !== 'ok');
    return {
      ready: true,
      body: { status: degraded ? 'degraded' : 'ok', checks: { db: 'ok', ...(components ?? {}) } },
    };
  };

  let cached: { at: number; value: Readiness } | null = null;
  let pending: Promise<Readiness> | null = null;
  const readiness = (): Promise<Readiness> => {
    if (cached && ctx.now().getTime() - cached.at < READY_CACHE_MS) return Promise.resolve(cached.value);
    // One refresh at a time: concurrent callers share it.
    pending ??= compute()
      .then((value) => {
        cached = { at: ctx.now().getTime(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  // Public: the answer names no configuration keys or internals; why it isn't ready goes to the service log.
  app.get('/readyz', { config: { rateLimit: READYZ_RATE_LIMIT } }, async () => {
    const state = await readiness();
    if (!state.ready) {
      throw new AppError(503, 'not_ready', 'AdminForge isn’t ready to serve requests.', {
        hint: 'Try again in a minute. If it persists, an administrator should check the AdminForge service logs.',
      });
    }
    return state.body;
  });
}
