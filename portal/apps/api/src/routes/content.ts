import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards';
import { loadCapabilities } from '../capabilities/capabilities';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import { outboundAppError } from '../execution/outbound';
import { search, SEARCH_TYPES, type SearchType } from '../search/search';
import { adminRoutes } from './admin';
import { datasourceRoutes } from './datasources';
import { definitionRoutes } from './definitions';
import { eventRoutes } from './events';
import { reportRoutes } from './reports';
import { viewRoutes } from './views';

/**
 * Content and platform routes, registered inside the /api scope (session + CSRF already enforced):
 * definitions, datasources, search, capabilities, saved views, report export, SSE events, audit, appearance, settings.
 * (GET /api/nav stays in routes/nav.ts.)
 */
export function contentRoutes(api: FastifyInstance, ctx: AppContext) {
  api.addHook('onClose', async () => {
    await ctx.events.close();
    await ctx.definitions.close();
  });

  definitionRoutes(api, ctx);
  datasourceRoutes(api, ctx);
  viewRoutes(api, ctx);
  reportRoutes(api, ctx);
  eventRoutes(api, ctx);
  adminRoutes(api, ctx);

  api.get<{ Querystring: { q?: string; type?: string } }>(
    '/search',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request) => {
      const session = requireSession(request);
      const type = request.query.type || undefined;
      if (type && !(SEARCH_TYPES as readonly string[]).includes(type))
        throw new AppError(400, 'invalid_request', `type must be one of ${SEARCH_TYPES.join(', ')}.`);
      return search(
        {
          definitions: ctx.definitions,
          outbound: ctx.outbound,
          timeoutMs: ctx.config.SEARCH_TIMEOUT_MS,
          fixtures: ctx.config.DATA_MODE === 'fixtures',
        },
        session,
        String(request.query.q ?? ''),
        { type: type as SearchType | undefined, correlationId: request.id },
      );
    },
  );

  api.get('/me/capabilities', async (request) => {
    const session = requireSession(request);
    try {
      return await loadCapabilities(ctx.outbound, session, request.id);
    } catch (err) {
      throw outboundAppError(err);
    }
  });
}
