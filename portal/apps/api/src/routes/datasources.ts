import { DatasourceExecuteManyRequest, DatasourceExecuteRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { AppContext } from '../context';
import { PAGE_KINDS, type DatasourceOutput, type LoadedPage, type UserScope } from '../datasources/executor';
import { RELOAD_HINT, resolveCurrent } from '../definitions/current';
import { parseBody } from '../errors';
import { outboundAppError } from '../execution/outbound';

export const userScope = (s: SessionRecord): UserScope => ({
  oid: s.userOid,
  upn: s.upn,
  name: s.displayName,
  roles: s.roles,
});

/**
 * The current published version of a page, dashboard or report. The browser sends the version it loaded: an older
 * one is refused (409 `version_superseded`, the browser reloads the definition) so a page's data is never fetched under
 * an older version's roles, licences or requests — and a retired page not at all.
 */
export async function currentPage(
  ctx: Pick<AppContext, 'definitions'>,
  kinds: readonly LoadedPage['kind'][],
  key: string,
  version: string | undefined,
): Promise<LoadedPage> {
  const r = await resolveCurrent(ctx.definitions, kinds, key, version, {
    hint: RELOAD_HINT.page,
    retired: 'is no longer available',
  });
  return { def: r.def as LoadedPage['def'], version: r.version, sha256: r.sha256, kind: r.kind, key };
}

export function datasourceRoutes(api: FastifyInstance, ctx: AppContext) {
  const runner = ctx.datasources;

  api.post('/datasources/execute', async (request): Promise<DatasourceOutput> => {
    const session = requireSession(request);
    const body = parseBody(DatasourceExecuteRequest, request.body);
    try {
      const page = await currentPage(ctx, PAGE_KINDS, body.page, body.version);
      runner.assertAccess(session.roles, page.def.requires, `Page ${page.key}`);
      const user = userScope(session);
      const params = await runner.prepareParams(page, body.params, user);
      return await runner.run({
        identity: { kind: 'delegated', session, mode: 'read' },
        user,
        page,
        datasource: body.datasource,
        params,
        cursor: body.cursor,
        correlationId: request.id,
      });
    } catch (err) {
      throw outboundAppError(err);
    }
  });

  api.post('/datasources/execute-many', async (request) => {
    const session = requireSession(request);
    const body = parseBody(DatasourceExecuteManyRequest, request.body);
    const page = await currentPage(ctx, PAGE_KINDS, body.page, body.version);
    runner.assertAccess(session.roles, page.def.requires, `Page ${page.key}`);
    const user = userScope(session);
    const params = await runner.prepareParams(page, body.params, user);
    // Declared order; independent datasources in parallel, dependents (ds.<name>) after what they reference.
    const names = body.datasources ?? Object.keys(page.def.datasources ?? {});
    const results = await runner.runMany(
      {
        identity: { kind: 'delegated', session, mode: 'read' },
        user,
        page,
        params,
        correlationId: request.id,
      },
      names,
    );
    // Each failed datasource carries the request's reference, so a widget's error can be traced in the logs.
    for (const r of Object.values(results) as Array<{ error?: Record<string, unknown> }>)
      if (r?.error && typeof r.error === 'object') r.error.correlationId = request.id;
    return { page: page.key, version: page.version, sha256: page.sha256, results };
  });
}
