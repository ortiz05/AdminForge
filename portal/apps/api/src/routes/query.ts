import type { FastifyInstance } from 'fastify';
import { requireRole, requireSession } from '../auth/guards';
import type { AppContext } from '../context';
import { parseBody } from '../errors';
import { scaffoldFromQuery, ScaffoldRequest } from '../query/scaffold';
import { tenantValuesFor } from '../query/tenant-values';
import { QueryRequest, QueryService } from '../query/service';

/**
 * Query Studio (R12):
 * - POST /api/query {source: resourceGraph|logAnalytics|advancedHunting, query, subscriptions?, workspace?, timespan?}
 *   → {columns: [{name, type}], rows, rowCount, truncated, ms, provenance} — the signed-in engineer's delegated read
 *   identity; at most 5000 rows; audited (sha256 of the query + its first 200 characters).
 * - POST /api/query/scaffold {as: report|probe|schedule, source, query, title, key?, scope?: all|default, …} →
 *   {yaml, path, key} — valid content YAML to commit through the normal review workflow (nothing is written on the
 *   server). Ids are configuration (R2): literal `subscriptions`/`workspace` are ignored (the YAML references
 *   `${ env.AF_SUBSCRIPTION_ID }` / `${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }`), and text holding a configured tenant
 *   value, a GUID or an onmicrosoft.com domain is refused with 400 `tenant_value_in_query` (naming the kind, not the value).
 */
export function queryRoutes(api: FastifyInstance, ctx: AppContext) {
  const svc = new QueryService({ outbound: ctx.outbound, audit: ctx.audit, env: ctx.contentEnv });

  api.post('/query', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const session = requireSession(request);
    const body = parseBody(QueryRequest, request.body);
    return svc.run({ session, correlationId: request.id, ip: request.ip ?? null }, body);
  });

  /** Configured tenant values that must never end up in content (R2); matched in the request, never echoed. */
  const tenantValues = (session: { tenantId: string; tenantDomain: string }) => tenantValuesFor(ctx, session);

  api.post('/query/scaffold', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Query Studio');
    return scaffoldFromQuery(parseBody(ScaffoldRequest, request.body), tenantValues(session));
  });
}
