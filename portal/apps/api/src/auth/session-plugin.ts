import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { auditActor, type AppContext } from '../context';
import { randomToken, sha256Hex } from '../security/tokens';
import { isArmed, type SessionRecord } from './session-store';
import { portalRoles } from './roles';
import { isGuestAccount, partitionKey, ReauthRequired } from './types';

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
  | 'rolesCheckedAt'
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
    // The roles come from the ID token just issued.
    rolesCheckedAt: now,
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
 * Sent by the SPA on requests nobody asked for (polling, auto-refresh, background summaries): they authenticate as
 * usual and are subject to idle expiry, but don't count as activity — an unattended tab still goes idle.
 */
export const BACKGROUND_HEADER = 'x-adminforge-background';

export const isBackgroundRequest = (request: Pick<FastifyRequest, 'headers'>) =>
  request.headers[BACKGROUND_HEADER] === '1';

/**
 * Resolves `request.session` from the cookie on every request, enforcing idle and absolute expiry,
 * sliding lastSeenAt (not for background requests), keeping the roles current (RoleCheck), and ending write access
 * whose window has closed (audited as session.arm_expired).
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
    if (!isBackgroundRequest(request) && now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      session = (await ctx.sessions.update(idHash, { lastSeenAt: now })) ?? session;
    }
    const current = await roleCheck.check(session, now, {
      correlationId: request.id,
      ip: request.ip,
      log: request.log,
    });
    if (!current) {
      clearSessionCookie(ctx, reply);
      return;
    }
    request.session = current;
    // Every later log line of this request says who: the object id, never the UPN.
    request.log = reply.log = request.log.child({ oid: current.userOid });
  });
}

/** How often a session's roles are re-read from Entra (removals and disabled accounts take effect within this). */
export const ROLE_RECHECK_MS = 5 * 60_000;
const ROLE_RETRY_MS = 60_000;
/** Without a successful confirmation for this long (Entra failing, or failing in a way we can't classify), end it. */
export const ROLE_FAIL_CLOSED_MS = 15 * 60_000;

/** Where a role check happens: a browser request (the API) or a delegated run step (the run worker). */
export interface RoleCheckOrigin {
  /** The request id or the run's correlation id (the audit event's reference). */
  correlationId: string;
  ip?: string | null;
  /** Set when a run step asked (recorded in the audit details). */
  runId?: string;
  log?: { warn(obj: object, msg: string): void };
}

/**
 * Roles come from the ID token at sign-in; this keeps them current for the session's lifetime — for browser requests
 * (the API's preHandler) and for runs acting as the session (the worker, before delegated steps), so a run keeps
 * nobody's access alive after it was removed. Every ROLE_RECHECK_MS the Read token is refreshed and `roles` re-read:
 * changes are applied and audited, losing Operator ends write access, a session left without an AdminForge role ends,
 * and so does one Entra won't refresh (disabled account, password reset, revoked sessions). Other failures keep the
 * session and retry after a minute — but only for ROLE_FAIL_CLOSED_MS after the last confirmation: a session whose
 * roles can't be confirmed for that long ends (fail closed). The last confirmation is stored on the session
 * (`rolesCheckedAt`), so every process sees the same one.
 */
export class RoleCheck {
  /** idHash → when the next attempt is due after a failed one (a back-off, so per process is enough). */
  private readonly retryAt = new Map<string, number>();
  /** idHash → the check in progress: parallel requests (or steps) of one session share one refresh. */
  private readonly inflight = new Map<string, Promise<SessionRecord | null>>();
  /** Sessions from before `rolesCheckedAt` was recorded count their unconfirmed time from this process's start. */
  private readonly startedAt: number;

  constructor(private readonly ctx: AppContext) {
    this.startedAt = ctx.now().getTime();
  }

  /** When the session's roles were last confirmed with Entra. */
  confirmedAt(session: SessionRecord): number {
    return session.rolesCheckedAt?.getTime() ?? Math.max(session.createdAt.getTime(), this.startedAt);
  }

  /** The session with current roles, or null when it ended (no role left, refused by Entra, or gone meanwhile). */
  async check(session: SessionRecord, now: Date, origin: RoleCheckOrigin): Promise<SessionRecord | null> {
    if (!this.ctx.auth || !session.readAccountId) return session;
    const t = now.getTime();
    if (t - this.confirmedAt(session) < ROLE_RECHECK_MS) return session;
    if (t < (this.retryAt.get(session.idHash) ?? 0)) return session;
    const running = this.inflight.get(session.idHash);
    if (running) return running;
    const next = this.recheck(session, now, origin).finally(() => this.inflight.delete(session.idHash));
    this.inflight.set(session.idHash, next);
    return next;
  }

  private async recheck(
    session: SessionRecord,
    now: Date,
    origin: RoleCheckOrigin,
  ): Promise<SessionRecord | null> {
    const { ctx } = this;
    const t = now.getTime();
    const confirmed = this.confirmedAt(session);
    if (this.retryAt.size > 50_000) this.retryAt.clear();
    let roles: string[];
    let reason: 'roles' | 'guest' | 'reauth' | 'unconfirmed' = 'roles';
    try {
      const claims = await ctx.auth!.refreshClaims({
        kind: 'read',
        partitionKey: partitionKey('read', session.idHash),
        homeAccountId: session.readAccountId!,
      });
      // An account turned into a guest keeps no access (guests are refused at sign-in too).
      roles = isGuestAccount(claims) ? [] : portalRoles(claims);
      if (isGuestAccount(claims)) reason = 'guest';
    } catch (err) {
      if (!(err instanceof ReauthRequired)) {
        if (t - confirmed < ROLE_FAIL_CLOSED_MS) {
          origin.log?.warn({ err: { name: (err as Error).name } }, 'role refresh failed; retrying shortly');
          this.retryAt.set(session.idHash, t + ROLE_RETRY_MS);
          return session;
        }
        origin.log?.warn(
          { err: { name: (err as Error).name } },
          'roles could not be confirmed for too long; ending the session',
        );
        reason = 'unconfirmed';
      } else reason = 'reauth';
      roles = [];
    }
    this.retryAt.delete(session.idHash);
    const actor = (s: SessionRecord) => ({
      ...auditActor(ctx, { id: origin.correlationId, ip: origin.ip ?? '' }, s),
      ip: origin.ip ?? null,
    });
    const by = origin.runId ? { runId: origin.runId } : {};
    const same = roles.length === session.roles.length && roles.every((r) => session.roles.includes(r));
    // Unchanged: record the confirmation (null when the session was ended meanwhile, e.g. signed out).
    if (same) return ctx.sessions.update(session.idHash, { rolesCheckedAt: now });
    if (roles.length === 0) {
      await endSession(ctx, session);
      await ctx.audit.append({
        ...actor(session),
        action: 'session.access_revoked',
        result: 'success',
        details: { previousRoles: session.roles, reason, ...by },
      });
      return null;
    }
    const updated = await ctx.sessions.update(session.idHash, { roles, rolesCheckedAt: now });
    if (!updated) return null;
    await ctx.audit.append({
      ...actor(updated),
      action: 'session.roles_changed',
      result: 'success',
      details: { previousRoles: session.roles, roles, ...by },
    });
    // Losing Operator also ends write access right away.
    if (!roles.includes('Portal.Operator') && (updated.writeAccountId || updated.writeExpiresAt))
      return dropWriteAccess(ctx, updated);
    return updated;
  }
}
