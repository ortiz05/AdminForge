import { DatasourceExecuteManyRequest, DatasourceExecuteRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { AppContext } from '../context';
import type { DatasourceOutput, UserScope } from '../datasources/executor';
import { parseBody } from '../errors';
import { outboundAppError } from '../execution/outbound';

export const userScope = (s: SessionRecord): UserScope => ({
  oid: s.userOid,
  upn: s.upn,
  name: s.displayName,
  roles: s.roles,
});

export function datasourceRoutes(api: FastifyInstance, ctx: AppContext) {
  const runner = ctx.datasources;

  api.post('/datasources/execute', async (request): Promise<DatasourceOutput> => {
    const session = requireSession(request);
    const body = parseBody(DatasourceExecuteRequest, request.body);
    try {
      const page = await runner.page(body.page, body.version);
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
    const page = await runner.page(body.page, body.version);
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
    return { page: page.key, version: page.version, sha256: page.sha256, results };
  });
}
