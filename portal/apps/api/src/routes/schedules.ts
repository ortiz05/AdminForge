import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, requireSession } from '../auth/guards';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import type { SchedulesModule } from '../schedules/module';
import type { Caller } from '../schedules/service';

/**
 * Schedules API (R6). Shapes (the web Schedules pages are built against these):
 * - GET   /api/schedules → {items: [{key, title, summary, cron, cronText, timezone, enabled, identity: 'automation',
 *         job: {kind, ref?, refs?, select?}, nextRunAt, lastRunAt, lastStatus, writeCapable, approvedBy?, source, pendingApprovalId}]}
 * - PATCH /api/schedules/:key {enabled} → 200 {key, enabled} | 202 {approvalId} (write-capable: a second person approves
 *         in the approvals inbox; Portal.Operator)
 * - POST  /api/schedules/:key/run → 202 {scheduleRunId} (Portal.Operator; audited)
 * - GET   /api/schedules/:key/runs?cursor=&limit= → {items: [{id, trigger, status, startedAt, endedAt, runId?,
 *         artifact?: {name, href, size}, error?}], cursor?}
 * - GET   /api/artifacts/:scheduleRunId → the report file (Portal.Reader; path-safe; audited)
 */

const Key = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/, 'Expected a schedule key like reports.weekly-x');
const ToggleBody = z.object({ enabled: z.boolean() });
const RunsQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const callerOf = (request: FastifyRequest): Caller => ({
  session: requireSession(request),
  correlationId: request.id,
  ip: request.ip ?? null,
});

function key(raw: string): string {
  const r = Key.safeParse(raw);
  if (!r.success) throw new AppError(404, 'schedule_not_found', `No schedule "${raw.slice(0, 100)}".`);
  return r.data;
}

export function scheduleRoutes(api: FastifyInstance, ctx: AppContext, schedules: SchedulesModule) {
  const svc = schedules.service;

  api.get('/schedules', async (request) => {
    requireRole(requireSession(request), 'Portal.Reader', 'Schedules');
    return svc.list();
  });

  api.patch<{ Params: { key: string } }>('/schedules/:key', async (request, reply) => {
    const body = parseBody(ToggleBody, request.body);
    const r = await svc.setEnabled(callerOf(request), key(request.params.key), body.enabled);
    return reply.status(r.statusCode).send(r.body);
  });

  api.post<{ Params: { key: string } }>(
    '/schedules/:key/run',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const r = await svc.runNow(callerOf(request), key(request.params.key));
      return reply.status(202).send(r);
    },
  );

  api.get<{ Params: { key: string } }>('/schedules/:key/runs', async (request) => {
    requireRole(requireSession(request), 'Portal.Reader', 'Schedule history');
    const q = RunsQuery.safeParse(request.query ?? {});
    if (!q.success)
      throw new AppError(
        400,
        'invalid_request',
        'cursor must be a cursor from a previous page; limit 1-100.',
      );
    return svc.runs(key(request.params.key), { cursor: q.data.cursor, limit: q.data.limit });
  });

  api.get<{ Params: { scheduleRunId: string } }>(
    '/artifacts/:scheduleRunId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const session = requireSession(request);
      requireRole(session, 'Portal.Reader', 'Downloading scheduled reports');
      const file = await svc.artifact(request.params.scheduleRunId, session);
      await ctx.audit
        .append({
          ...auditActor(ctx, request, session),
          action: 'artifact.downloaded',
          targetType: 'schedule_run',
          targetId: request.params.scheduleRunId,
          result: 'success',
          details: { schedule: file.scheduleKey, name: file.name, size: file.size },
        })
        .catch((err: unknown) => request.log.error({ err }, 'audit of artifact download failed'));
      return reply
        .header('content-type', file.contentType)
        .header('content-length', String(file.size))
        .header(
          'content-disposition',
          `attachment; filename="${file.name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        )
        .header('x-content-type-options', 'nosniff')
        .send(file.stream);
    },
  );
}
