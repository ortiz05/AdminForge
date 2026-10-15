import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { auditActor, type AppContext } from '../context';
import { randomToken, sha256Hex } from '../security/tokens';
import { isArmed, type SessionRecord } from './session-store';
import { portalRoles } from './roles';
import { partitionKey, ReauthRequired } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in session, or null. Set by the session hook on every request. */
    session: SessionRecord | null;
  }
}

/** Only refresh lastSeenAt once a minute to keep writes cheap. */
const TOUCH_INTERVAL_MS = 60_000;
/** Only API and auth routes look at the session (static files and health checks don't). */
const SESSION_PATHS = /^\/(api|auth)(\/|$|\?)/;

export const sessionCookieName = (cfg: Pick<Config, 'NODE_ENV'>) =>
  cfg.NODE_ENV === 'production' ? '__Host-adminforge' : 'adminforge-dev';

export function sessionCookieOptions(
  cfg: Pick<Config, 'NODE_ENV' | 'PUBLIC_BASE_URL' | 'SESSION_ABSOLUTE_HOURS'>,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // __Host- requires Secure; dev over http://localhost can't use it.
    secure: cfg.NODE_ENV === 'production' || cfg.PUBLIC_BASE_URL.startsWith('https://'),
    maxAge: cfg.SESSION_ABSOLUTE_HOURS * 3600,
  };
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply) {
  const { maxAge: _maxAge, ...opts } = sessionCookieOptions(ctx.config);
  reply.clearCookie(sessionCookieName(ctx.config), opts);
}

export type NewSession = Omit<
  SessionRecord,
  | 'idHash'
  | 'csrf'
  | 'createdAt'
  | 'lastSeenAt'
  | 'expiresAt'
  | 'ip'
  | 'userAgent'
  | 'writeExtended'
  | 'writeReason'
  | 'writeAccountId'
  | 'writeExpiresAt'
> &
  Partial<Pick<SessionRecord, 'writeAccountId' | 'writeExpiresAt' | 'writeReason'>>;

/** Creates a session with a fresh random id (never reusing one the browser presented) and sets the cookie. */
export async function startSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  data: NewSession,
  sid = randomToken(),
): Promise<SessionRecord> {
  const now = ctx.now();
  const record: SessionRecord = {
    writeAccountId: null,
    writeExpiresAt: null,
    writeReason: null,
    ...data,
    idHash: sha256Hex(sid),
    csrf: randomToken(),
    writeExtended: false,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.SESSION_ABSOLUTE_HOURS * 3_600_000),
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
  };
  await ctx.sessions.create(record);
  reply.setCookie(sessionCookieName(ctx.config), sid, sessionCookieOptions(ctx.config));
  request.session = record;
  return record;
}

/** Deletes the session and both token-cache partitions. */
export async function endSession(ctx: AppContext, session: SessionRecord) {
  await ctx.sessions.delete(session.idHash);
  await forgetPartition(ctx, 'read', session.idHash);
  await forgetPartition(ctx, 'write', session.idHash);
}

async function forgetPartition(ctx: AppContext, kind: 'read' | 'write', idHash: string) {
  const key = partitionKey(kind, idHash);
  if (ctx.auth) await ctx.auth.forget({ kind, partitionKey: key });
  await ctx.tokenCache.delete(key);
}

/** Drops write access: clears the Write-app account and its cache partition. */
export async function dropWriteAccess(ctx: AppContext, session: SessionRecord): Promise<SessionRecord> {
  await forgetPartition(ctx, 'write', session.idHash);
  const updated = await ctx.sessions.update(session.idHash, {
    writeAccountId: null,
    writeExpiresAt: null,
    writeExtended: false,
    writeReason: null,
  });
  return (
    updated ?? {
      ...session,
      writeAccountId: null,
      writeExpiresAt: null,
      writeExtended: false,
      writeReason: null,
    }
  );
}

/**
 * Resolves `request.session` from the cookie on every request, enforcing idle and absolute expiry,
 * sliding lastSeenAt, and ending write access whose window has closed (audited as session.arm_expired).
 */
export function registerSessions(app: FastifyInstance, ctx: AppContext) {
  const cookieName = sessionCookieName(ctx.config);
  const idleMs = ctx.config.SESSION_IDLE_MINUTES * 60_000;
  const roleCheck = new RoleCheck(ctx);
  app.decorateRequest('session', null);

  // preHandler (not onRequest) so route rate limits reject floods before any session lookup.
  app.addHook('preHandler', async (request, reply) => {
    request.session = null;
    if (!SESSION_PATHS.test(request.url)) return;
    const sid = request.cookies[cookieName];
    if (!sid) return;
    const idHash = sha256Hex(sid);
    let session = await ctx.sessions.get(idHash);
    if (!session) {
      clearSessionCookie(ctx, reply);
      return;
    }
    const now = ctx.now();
    if (
      now.getTime() >= session.expiresAt.getTime() ||
      now.getTime() - session.lastSeenAt.getTime() > idleMs
    ) {
      await endSession(ctx, session);
      clearSessionCookie(ctx, reply);
      return;
    }
    if (session.writeAccountId && !isArmed(session, now)) {
      const expiredAt = session.writeExpiresAt?.toISOString() ?? null;
      session = await dropWriteAccess(ctx, session);
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'session.arm_expired',
        result: 'success',
        details: { expiredAt },
      });
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      session = (await ctx.sessions.update(idHash, { lastSeenAt: now })) ?? session;
    }
    const current = await roleCheck.check(request, session, now);
    if (!current) {
      clearSessionCookie(ctx, reply);
      return;
    }
    request.session = current;
  });
}

/** How often a session's roles are re-read from Entra (removals and disabled accounts take effect within this). */
export const ROLE_RECHECK_MS = 5 * 60_000;
const ROLE_RETRY_MS = 60_000;

/**
 * Roles come from the ID token at sign-in; this keeps them current for the session's lifetime. Every ROLE_RECHECK_MS
 * the Read token is refreshed and `roles` re-read: changes are applied and audited, a session left without an
 * AdminForge role ends, and so does one Entra won't refresh (disabled account, password reset, policy). Transient
 * failures keep the session and retry after a minute.
 */
export class RoleCheck {
  /** idHash → when the session's roles were last confirmed (in this process; a restart rechecks once). */
  private readonly checked = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {}

  async check(request: FastifyRequest, session: SessionRecord, now: Date): Promise<SessionRecord | null> {
    const { ctx } = this;
    if (!ctx.auth || !session.readAccountId) return session;
    const last = this.checked.get(session.idHash) ?? session.createdAt.getTime();
    if (now.getTime() - last < ROLE_RECHECK_MS) return session;
    if (this.checked.size > 50_000) this.checked.clear();
    let roles: string[];
    try {
      const claims = await ctx.auth.refreshClaims({
        kind: 'read',
        partitionKey: partitionKey('read', session.idHash),
        homeAccountId: session.readAccountId,
      });
      roles = portalRoles(claims);
    } catch (err) {
      if (!(err instanceof ReauthRequired)) {
        request.log.warn({ err: { name: (err as Error).name } }, 'role refresh failed; retrying shortly');
        this.checked.set(session.idHash, now.getTime() - ROLE_RECHECK_MS + ROLE_RETRY_MS);
        return session;
      }
      roles = [];
    }
    this.checked.set(session.idHash, now.getTime());
    const same = roles.length === session.roles.length && roles.every((r) => session.roles.includes(r));
    if (same) return session;
    if (roles.length === 0) {
      this.checked.delete(session.idHash);
      await endSession(ctx, session);
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'session.access_revoked',
        result: 'success',
        details: { previousRoles: session.roles },
      });
      return null;
    }
    const updated = (await ctx.sessions.update(session.idHash, { roles })) ?? { ...session, roles };
    await ctx.audit.append({
      ...auditActor(ctx, request, updated),
      action: 'session.roles_changed',
      result: 'success',
      details: { previousRoles: session.roles, roles },
    });
    // Losing Operator also ends write access right away.
    if (!roles.includes('Portal.Operator') && (updated.writeAccountId || updated.writeExpiresAt))
      return dropWriteAccess(ctx, updated);
    return updated;
  }
}
