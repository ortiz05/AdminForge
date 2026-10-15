import type { FastifyInstance } from 'fastify';
import { requireRole, requireSession } from '../auth/guards';
import { APPEARANCE_KEY, appearanceCss, Appearance, validateAppearance } from '../admin/appearance';
import { queryAudit, verifyAudit } from '../admin/audit-query';
import { writeAppConfigured } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError } from '../errors';

const isoDate = (v: string | undefined, name: string) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'invalid_request', `${name} must be an ISO date.`);
  return d;
};

async function currentAppearance(ctx: AppContext) {
  const rec = await ctx.settings.get<unknown>(APPEARANCE_KEY);
  const parsed = Appearance.safeParse(rec?.value ?? {});
  return { version: rec?.version ?? 0, ...(parsed.success ? parsed.data : { overrides: {} }) };
}

/** Audit log, appearance overrides and installation settings (§9). Portal.Admin except /appearance.css. */
export function adminRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get<{ Querystring: { actor?: string; action?: string; from?: string; to?: string; cursor?: string; limit?: string } }>('/audit', async (request) => {
    requireRole(requireSession(request), 'Portal.Admin', 'Reading the audit log');
    const q = request.query;
    const limit = q.limit && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined;
    return queryAudit(ctx.database, ctx.audit, { actor: q.actor || undefined, action: q.action || undefined, from: isoDate(q.from, 'from'), to: isoDate(q.to, 'to'), cursor: q.cursor, limit });
  });

  api.get('/audit/verify', async (request) => {
    requireRole(requireSession(request), 'Portal.Admin', 'Verifying the audit chain');
    return verifyAudit(ctx.audit);
  });

  api.get('/admin/appearance', async (request) => {
    requireRole(requireSession(request), 'Portal.Admin', 'Appearance settings');
    return currentAppearance(ctx);
  });

  /** Body: {overrides, density?, fontScale?, version?}; `version` = the version the edit started from (409 if stale). */
  api.put('/admin/appearance', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Admin', 'Changing the appearance');
    const { version, ...value } = validateAppearance(request.body);
    const before = await currentAppearance(ctx);
    const saved = await ctx.settings.put(APPEARANCE_KEY, value, { updatedBy: session.userOid, now: ctx.now(), expectedVersion: version });
    if (!saved) throw new AppError(409, 'conflict', 'Someone else changed the appearance meanwhile. Reload and apply your change again.');
    const changedThemes = Object.keys({ ...before.overrides, ...value.overrides }).filter(
      (t) => JSON.stringify(before.overrides[t as keyof typeof before.overrides] ?? {}) !== JSON.stringify(value.overrides[t as keyof typeof value.overrides] ?? {}),
    );
    await ctx.audit.append({
      ...auditActor(ctx, request, session),
      action: 'appearance.updated',
      targetType: 'settings',
      targetId: APPEARANCE_KEY,
      result: 'success',
      details: { version: saved.version, themes: changedThemes, density: value.density ?? null, fontScale: value.fontScale ?? null, overrides: value.overrides },
    });
    ctx.events.publish({ type: 'appearance.changed', data: { version: saved.version } });
    return { version: saved.version, ...value };
  });

  /** Runtime overrides as CSS (load after tokens.css). ETag = version. */
  api.get('/appearance.css', async (request, reply) => {
    requireSession(request);
    const a = await currentAppearance(ctx);
    const etag = `"appearance-${a.version}"`;
    reply.header('etag', etag).header('content-type', 'text/css; charset=utf-8');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return appearanceCss(a, a.version);
  });

  api.get('/admin/settings', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Admin', 'Installation settings');
    const c = ctx.config;
    return {
      authMode: c.AUTH_MODE,
      dataMode: c.DATA_MODE,
      contentSource: c.CONTENT_SOURCE,
      writeSessionMaxMinutes: c.WRITE_SESSION_MAX_MINUTES,
      apps: { read: Boolean(c.AF_READ_CLIENT_ID && c.AF_READ_CLIENT_SECRET), write: writeAppConfigured(c), automation: ctx.automation !== null },
      tenant: { name: session.tenantName, domain: session.tenantDomain },
    };
  });
}
