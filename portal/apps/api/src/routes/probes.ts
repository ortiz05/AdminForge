import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRole, requireRole, requireSession } from '../auth/guards';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import type { SchedulesModule } from '../schedules/module';
import { SCHEDULED_DATA_ROLES } from '../schedules/service';

/**
 * Synthetic probes (R6, R12):
 * - GET /api/probes → {items: [{key, title, kind, latest: {status, metric, unit, ts, message} | null,
 *       series: [{ts, metric, status}] (last 24 h), thresholds: {warn, crit, unit, worse}}]}
 * - GET /api/probes/:key/results?since=<ISO> → {items: [{ts, status, metric, unit, durationMs, message,
 *       details: {rows, columns?, totalRows?} | null, scheduleRunId}]} (newest first; default 24 h, at most 31 days)
 */

const Key = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/);
const ResultsQuery = z.object({ since: z.string().max(40).optional() });

export function probeRoutes(api: FastifyInstance, _ctx: AppContext, schedules: SchedulesModule) {
  api.get('/probes', async (request) => {
    requireRole(requireSession(request), 'Portal.Reader', 'Monitoring');
    return schedules.probes.list();
  });

  api.get<{ Params: { key: string } }>('/probes/:key/results', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Monitoring');
    const k = Key.safeParse(request.params.key);
    if (!k.success) throw new AppError(404, 'probe_not_found', 'No such probe.');
    const q = ResultsQuery.safeParse(request.query ?? {});
    if (!q.success) throw new AppError(400, 'invalid_request', 'since must be an ISO date-time.');
    const results = await schedules.probes.results(k.data, q.data.since);
    // Result rows were collected with the automation identity's application permissions: status and metric for
    // everyone, the rows themselves only for the roles that may see scheduled data.
    if (SCHEDULED_DATA_ROLES.every((r) => hasRole(session, r))) return results;
    return {
      ...results,
      items: results.items.map((i) => ({ ...i, details: null, detailsHidden: i.details !== null })),
    };
  });
}
