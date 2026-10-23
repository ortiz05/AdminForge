import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasRole, requireRole, requireSession } from '../auth/guards';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import type { SchedulesModule } from '../schedules/module';
import { tenantValuesFor } from '../query/tenant-values';
import {
  copiedRequires,
  previewSchedule,
  ScheduleScaffoldRequest,
  scaffoldSchedule,
} from '../schedules/scaffold';
import { TimeZone, type PortalRole } from '@adminforge/schemas';
import type { Caller } from '../schedules/service';

/**
 * Schedules API (R6). Shapes (the web Schedules pages are built against these):
 * - GET   /api/schedules → {items: [{key, title, summary, cron, cronText, timezone, enabled, identity: 'automation',
 *         job: {kind, ref?, refs?, select?, params?}, nextRunAt, lastRunAt, lastStatus, writeCapable, approvedBy?, source,
 *         createdBy, canManage, delivery?, notify?, pendingApprovalId}]}
 * - GET   /api/schedules/:key → one item (same shape)
 * - GET   /api/schedules/delivery-options → {email: {available, lists}, teams: {lists}, identities: {apps, user}}
 *         (Portal.Operator; key names only)
 * - GET   /api/schedules/identities → {apps, user}: who schedules may run as here (Portal.Reader; ADR-014)
 * - POST  /api/schedules (report schedule created in the portal; Portal.Operator; audited) → 201 item
 * - PUT   /api/schedules/:key (portal schedule; its creator or Portal.Admin; audited) → 200 item
 * - DELETE /api/schedules/:key (portal schedule; its creator or Portal.Admin; soft delete; audited) → 204
 * - PUT   /api/schedules/:key/run-as {identity: 'automation' | 'app:<name>' | null} (content schedule; Portal.Operator;
 *         the identity must hold the permissions it declares; write-capable → turned off, re-enabling is approved for
 *         the new account; audited) → 200 item (+ disabled: true)
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
/** `automation`, `app:<name>`, or null to go back to the definition / installation default. */
const RunAsBody = z.object({ identity: z.string().max(64).nullable() });
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

/** Cron, or the same in English (`every`: "every weekday at 07:00"); one of the two. */
const CronPreviewRequest = z
  .object({
    cron: z.string().trim().min(1).max(100).optional(),
    every: z.string().trim().min(1).max(200).optional(),
    timezone: TimeZone,
  })
  .refine((b) => (b.cron === undefined) !== (b.every === undefined), {
    message: 'Send either cron or every',
    path: ['cron'],
  });

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
  api.get('/schedules/identities', async (request) => schedules.portal.identities(requireSession(request)));

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

  // Each change checks the account's permissions live with the automation identity (a Graph read): rate-limited.
  api.put<{ Params: { key: string } }>(
    '/schedules/:key/run-as',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseBody(RunAsBody, request.body);
      const caller = callerOf(request);
      const k = key(request.params.key);
      const { disabled } = await svc.setRunAs(caller, k, body.identity);
      return { ...(await svc.get(k, caller.session)), ...(disabled ? { disabled: true } : {}) };
    },
  );

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
    return previewSchedule(body, body.timezone, ctx.now());
  });

  api.post('/schedules/scaffold', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Creating a schedule');
    return scaffoldSchedule(parseBody(ScheduleScaffoldRequest, request.body), {
      known: tenantValuesFor(ctx, session),
      now: ctx.now(),
      requiresOf: async (kind, key) => {
        const def = (await ctx.definitions.resolve(kind, key).catch(() => null))?.def as
          { requires?: { scopes?: unknown; licences?: unknown; portalRoles?: PortalRole[] } } | undefined;
        if (!def) throw new AppError(404, 'definition_not_found', `There is no published ${kind} "${key}".`);
        // The same rule as GET /api/definitions/:kind/:key: a definition's requirements are part of its content.
        const roles = def.requires?.portalRoles ?? [];
        if (!roles.every((r) => hasRole(session, r)))
          throw new AppError(403, 'forbidden', `This ${kind} needs the ${roles.join(' and ')} role.`, {
            hint: 'Ask a portal administrator for access.',
          });
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
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', 'Schedule history');
    const q = RunsQuery.safeParse(request.query ?? {});
    if (!q.success)
      throw new AppError(
        400,
        'invalid_request',
        'cursor must be a cursor from a previous page; limit 1-100.',
      );
    return svc.runs(key(request.params.key), { cursor: q.data.cursor, limit: q.data.limit }, session);
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
          details: {
            schedule: file.scheduleKey,
            name: file.name,
            size: file.size,
            // A Portal Admin opening the files of a schedule that runs with someone else's access.
            ...(file.adminOverride ? { adminOverride: true } : {}),
          },
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
