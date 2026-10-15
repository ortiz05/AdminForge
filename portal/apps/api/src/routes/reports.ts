import { ExportRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards';
import { auditActor, type AppContext } from '../context';
import { PAGE_KINDS, type LoadedPage } from '../datasources/executor';
import { parseBody } from '../errors';
import { outboundAppError } from '../execution/outbound';
import { advancedParamOf, describeAdvanced, type AdvancedGroup } from '../datasources/advanced';
import { contentType, exportPages, exportStream, planExport } from '../reports/export';
import { userScope } from './datasources';

const EXPORT_KINDS = ['report', ...PAGE_KINDS.filter((k) => k !== 'report')] as const;

/** Params as audited: `redact: true` params are masked; the query builder's filter in its wire form. */
function auditParams(page: LoadedPage, params: Record<string, unknown>) {
  const adv = advancedParamOf(page.def.filters);
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, k === adv && v ? describeAdvanced(v as AdvancedGroup) : page.def.params?.[k]?.redact ? '[redacted]' : v]),
  );
}

export function reportRoutes(api: FastifyInstance, ctx: AppContext) {
  api.post<{ Params: { key: string } }>('/reports/:key/export', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = requireSession(request);
    const body = parseBody(ExportRequest, request.body);
    const runner = ctx.datasources;
    const resolved = await ctx.definitions.resolveAny(EXPORT_KINDS, request.params.key, body.version);
    const page: LoadedPage = { def: resolved.def, version: resolved.version, sha256: resolved.sha256, kind: resolved.kind, key: request.params.key };
    runner.assertAccess(session.roles, page.def.requires, `Exporting ${page.key}`);
    const user = userScope(session);
    const params = await runner.prepareParams(page, body.params, user);
    const plan = await planExport(page, runner.publicParams(page, params), body.format, { columns: body.columns, maxRows: ctx.config.EXPORT_MAX_ROWS });
    const audit = (result: 'success' | 'failure', details: Record<string, unknown>) =>
      ctx.audit
        .append({
          ...auditActor(ctx, request, session),
          action: 'report.exported',
          targetType: page.kind,
          targetId: page.key,
          result,
          details: { version: page.version, format: body.format, params: auditParams(page, params), columns: plan.columns.map((c) => c.field), ...details },
        })
        .catch((err: unknown) => request.log.error({ err }, 'audit of report export failed'));

    // The first page is fetched before the response starts, so permission and policy errors still return JSON.
    const pages = exportPages(runner, { identity: { kind: 'delegated', session, mode: 'read' }, user, page, params, correlationId: request.id }, plan);
    let first: IteratorResult<{ rows: Record<string, unknown>[]; truncated: boolean }>;
    try {
      first = await pages.next();
    } catch (err) {
      const e = outboundAppError(err);
      await audit('failure', { error: e.code });
      throw e;
    }
    const all = (async function* () {
      if (!first.done) yield first.value;
      yield* pages;
    })();
    const stream = exportStream(body.format, plan.columns, all, (err, stats) => {
      if (err) request.log.warn({ err }, 'report export failed while streaming');
      void audit(err ? 'failure' : 'success', { rows: stats.rows, truncated: stats.truncated, ...(err ? { error: outboundAppError(err).code } : {}) });
    });
    return reply
      .header('content-type', contentType(body.format))
      .header('content-disposition', `attachment; filename="${plan.fileName}"; filename*=UTF-8''${encodeURIComponent(plan.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .send(stream);
  });
}
