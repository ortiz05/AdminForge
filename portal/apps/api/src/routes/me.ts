import { UserPrefs, type MeResponse } from '@adminforge/schemas';
import { APPEARANCE_KEY, Appearance } from '../admin/appearance';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import { isArmed, type SessionRecord } from '../auth/session-store';
import { writeAppConfigured } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';

/** Builds the exact GET /api/me contract for a session. */
/** Default theme and density from Admin → Appearance (never fails /api/me). */
async function orgDefaults(ctx: AppContext): Promise<MeResponse['defaults']> {
  try {
    const parsed = Appearance.safeParse((await ctx.settings.get<unknown>(APPEARANCE_KEY))?.value ?? {});
    if (!parsed.success) return {};
    return {
      ...(parsed.data.theme ? { theme: parsed.data.theme } : {}),
      ...(parsed.data.density ? { density: parsed.data.density } : {}),
    };
  } catch {
    return {};
  }
}

export async function buildMe(ctx: AppContext, session: SessionRecord): Promise<MeResponse> {
  const armed = isArmed(session, ctx.now());
  return {
    user: { oid: session.userOid, upn: session.upn, name: session.displayName, tenantId: session.tenantId },
    tenant: { name: session.tenantName, domain: session.tenantDomain },
    roles: session.roles,
    mode: armed ? 'armed' : 'read',
    armedUntil: armed ? session.writeExpiresAt!.toISOString() : null,
    canArm:
      hasRole(session, 'Portal.Operator') &&
      (ctx.config.AUTH_MODE === 'mock' || writeAppConfigured(ctx.config)),
    armExtended: armed && session.writeExtended,
    armMaxMinutes: ctx.config.WRITE_SESSION_MAX_MINUTES,
    csrf: session.csrf,
    prefs: await ctx.prefs.get(session.userOid),
    defaults: await orgDefaults(ctx),
    authMode: ctx.config.AUTH_MODE,
    dataMode: ctx.config.DATA_MODE,
    querySources: [...ctx.config.AF_QUERY_SOURCES],
  };
}

/** Registered inside the /api scope (session + CSRF already enforced). */
export function meRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get('/me', async (request) => buildMe(ctx, requireSession(request)));

  const NAVIGATION_STATE = new Set([
    'recents',
    'navOpenSections',
    'navSections',
    'newsSeenAt',
    'kpiCollapsed',
  ]);
  /** Merges the given keys into the stored prefs; unknown keys are rejected (400). */
  api.put('/me/prefs', async (request) => {
    const session = requireSession(request);
    const patch = parseBody(UserPrefs.strict(), request.body);
    // "Mark all as read" sets now; a marker in the future would hide news that hasn't happened yet.
    if (patch.newsSeenAt && Date.parse(patch.newsSeenAt) > ctx.now().getTime() + 5 * 60_000)
      throw new AppError(400, 'invalid_request', 'The read marker for News and changes is in the future.', {
        hint: 'Check this computer’s clock, then mark the news as read again.',
      });
    const current = await ctx.prefs.get(session.userOid);
    const prefs: UserPrefs = { ...current, ...patch };
    await ctx.prefs.put(session.userOid, prefs);
    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify(current[k as keyof UserPrefs]) !== JSON.stringify(patch[k as keyof UserPrefs]),
    );
    // Settings are audited; navigation state (recent pages, open sections, the news read marker) changes on every
    // click and isn't.
    if (changed.some((k) => !NAVIGATION_STATE.has(k))) {
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'prefs.updated',
        targetType: 'user',
        targetId: session.userOid,
        result: 'success',
        details: { changed },
      });
    }
    return { prefs };
  });
}
