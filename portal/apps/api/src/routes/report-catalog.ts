import { DefinitionId } from '@adminforge/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole, requireSession } from '../auth/guards';
import type { AppContext } from '../context';
import { definitionNotFound } from '../definitions/registry';
import { reportCatalog, reportDetail, type CatalogDeps } from '../reports/catalog';
import type { SchedulesModule } from '../schedules/module';

/**
 * The Reports catalogue (Portal.Reader):
 * - GET /api/reports      → {items: ReportCatalogItem[], areas: [{key, label, icon}]} (reports the caller may open)
 * - GET /api/reports/:key → ReportCatalogItem & {columns: [{field, label}]} (404 definition_not_found; 403 forbidden)
 * Shapes: packages/schemas/src/api-reports.ts. Scheduling one: POST /api/schedules (routes/schedules.ts).
 */
export function reportCatalogRoutes(api: FastifyInstance, ctx: AppContext, schedules: SchedulesModule) {
  const deps = (request: FastifyRequest): CatalogDeps => {
    const session = requireSession(request);
    return {
      definitions: ctx.definitions,
      licences: () =>
        ctx.licences.get({ kind: 'delegated', session, mode: 'read' }, { correlationId: request.id }),
      schedules: () => schedules.service.list(session),
      exportMaxRows: ctx.config.EXPORT_MAX_ROWS,
    };
  };

  api.get('/reports', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Reports');
    return reportCatalog(deps(request), session);
  });

  api.get<{ Params: { key: string } }>('/reports/:key', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Reports');
    const key = DefinitionId.safeParse(request.params.key);
    if (!key.success) throw definitionNotFound('report', request.params.key.slice(0, 100));
    return reportDetail(deps(request), session, key.data);
  });
}
