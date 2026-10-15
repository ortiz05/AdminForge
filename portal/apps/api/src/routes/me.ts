import { UserPrefs, type MeResponse } from '@adminforge/schemas';
import { APPEARANCE_KEY, Appearance } from '../admin/appearance';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import { isArmed, type SessionRecord } from '../auth/session-store';
import { writeAppConfigured } from '../config';
import { auditActor, type AppContext } from '../context';
import { parseBody } from '../errors';

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
  };
}

/** Registered inside the /api scope (session + CSRF already enforced). */
export function meRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get('/me', async (request) => buildMe(ctx, requireSession(request)));

  /** Merges the given keys into the stored prefs; unknown keys are rejected (400). */
  api.put('/me/prefs', async (request) => {
    const session = requireSession(request);
    const patch = parseBody(UserPrefs.strict(), request.body);
    const current = await ctx.prefs.get(session.userOid);
    const prefs: UserPrefs = { ...current, ...patch };
    await ctx.prefs.put(session.userOid, prefs);
    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify(current[k as keyof UserPrefs]) !== JSON.stringify(patch[k as keyof UserPrefs]),
    );
    if (changed.length) {
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
