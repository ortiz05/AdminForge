import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, requireSession } from '../auth/guards';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import type { SchedulesModule } from '../schedules/module';
import { tenantValuesFor } from '../query/tenant-values';
import {
  copiedRequires,
  previewCron,
  ScheduleScaffoldRequest,
  scaffoldSchedule,
} from '../schedules/scaffold';
import { TimeZone } from '@adminforge/schemas';
import type { Caller } from '../schedules/service';

/**
 * Schedules API (R6). Shapes (the web Schedules pages are built against these):
 * - GET   /api/schedules → {items: [{key, title, summary, cron, cronText, timezone, enabled, identity: 'automation',
 *         job: {kind, ref?, refs?, select?, params?}, nextRunAt, lastRunAt, lastStatus, writeCapable, approvedBy?, source,
 *         createdBy, canManage, delivery?, notify?, pendingApprovalId}]}
 * - GET   /api/schedules/:key → one item (same shape)
 * - GET   /api/schedules/delivery-options → {email: {available, lists}, teams: {lists}} (Portal.Operator; key names only)
 * - POST  /api/schedules (report schedule created in the portal; Portal.Operator; audited) → 201 item
 * - PUT   /api/schedules/:key (portal schedule; its creator or Portal.Admin; audited) → 200 item
 * - DELETE /api/schedules/:key (portal schedule; its creator or Portal.Admin; soft delete; audited) → 204
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

const CronPreviewRequest = z.object({ cron: z.string().trim().min(1).max(100), timezone: TimeZone });

export function scheduleRoutes(api: FastifyInstance, ctx: AppContext, schedules: SchedulesModule) {
  const svc = schedules.service;

  api.get('/schedules', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Schedules');
    return svc.list(session);
  });

  // Report schedules created in the portal (schedules/portal.ts): report jobs only, delivery to configured keys.
  api.get('/schedules/delivery-options', async (request) =>
    schedules.portal.deliveryOptions(requireSession(request)),
  );

  api.post(
    '/schedules',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) =>
      reply.status(201).send(await schedules.portal.create(callerOf(request), request.body)),
  );

  api.get<{ Params: { key: string } }>('/schedules/:key', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Schedules');
    return svc.get(key(request.params.key), session);
  });

  api.put<{ Params: { key: string } }>('/schedules/:key', async (request) =>
    schedules.portal.update(callerOf(request), key(request.params.key), request.body),
  );

  api.delete<{ Params: { key: string } }>('/schedules/:key', async (request, reply) => {
    await schedules.portal.remove(callerOf(request), key(request.params.key));
    return reply.status(204).send();
  });

  // Schedule editor (R6): live cron preview, and YAML for a new schedule. Nothing is stored; the YAML goes through git.
  api.post('/schedules/preview', async (request) => {
    requireRole(requireSession(request), 'Portal.Reader', 'Previewing a schedule');
    const body = parseBody(CronPreviewRequest, request.body);
    return previewCron(body.cron, body.timezone, ctx.now());
  });

  api.post('/schedules/scaffold', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Creating a schedule');
    return scaffoldSchedule(parseBody(ScheduleScaffoldRequest, request.body), {
      known: tenantValuesFor(ctx, session),
      now: ctx.now(),
      requiresOf: async (kind, key) => {
        const def = (await ctx.definitions.resolve(kind, key).catch(() => null))?.def as
          { requires?: { scopes?: unknown; licences?: unknown } } | undefined;
        if (!def) throw new AppError(404, 'definition_not_found', `There is no published ${kind} "${key}".`);
        return copiedRequires(def.requires);
      },
    });
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
