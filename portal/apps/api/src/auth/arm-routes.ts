import { ArmRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAppConfigured } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody, unauthenticated } from '../errors';
import { randomToken, sha256Hex } from '../security/tokens';
import {
  acrsOf,
  authContextClaims,
  beginRoundTrip,
  browserBinding,
  finishRoundTrip,
  providerAuditDetails,
  providerDescription,
  providerError,
  type CallbackQuery,
} from './flow';
import { requireRole, requireSession, requireSessionWithCsrf } from './guards';
import { safeReturnTo } from './return-to';
import { dropWriteAccess, rotateSession } from './session-plugin';
import { isArmed, type SessionRecord } from './session-store';
import { accountStatusMissing, guestAccount } from './routes';
import { hasAccountStatus, isGuestAccount, partitionKey } from './types';

export const ARM_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

/** The Write app sign-in must have happened within this many seconds (with or without WRITE_AUTH_CONTEXT). */
export const STEP_UP_MAX_AGE_SECONDS = 300;

/**
 * What arming proves on this installation: `authContext` — a fresh interactive sign-in that also satisfied the
 * Conditional Access authentication context (WRITE_AUTH_CONTEXT, typically MFA); `freshSignIn` — a fresh interactive
 * sign-in only, which Entra may complete with a password alone; `none` — mock mode. Recorded on every `session.armed`
 * and shown in the installation settings.
 */
export const stepUpStrength = (
  cfg: Pick<AppContext['config'], 'AUTH_MODE' | 'WRITE_AUTH_CONTEXT'>,
): 'authContext' | 'freshSignIn' | 'none' =>
  cfg.AUTH_MODE === 'mock' ? 'none' : cfg.WRITE_AUTH_CONTEXT ? 'authContext' : 'freshSignIn';

/** Body of POST /auth/arm/extend. Without `minutes` the extension is WRITE_SESSION_MAX_MINUTES. */
export const ExtendRequest = z.object({ minutes: z.number().int().min(5).max(480).optional() });

/** The armed window: requested minutes capped by WRITE_SESSION_MAX_MINUTES. */
export const armMinutes = (ctx: AppContext, requested: number) =>
  Math.min(requested, ctx.config.WRITE_SESSION_MAX_MINUTES);

const notArmed = () =>
  new AppError(409, 'not_armed', 'Write access is off.', { hint: 'Arm write access first.' });

/**
 * Extend (once per armed session) and disarm — identical in mock and Entra modes. Neither rotates the session id
 * (S-08 rotates it on arming): the id was already renewed at the step-up, extending proves nothing new and grants no
 * more than the step-up did (the same window, once), and disarming — like expiry and losing Operator, which happen in
 * whatever request comes next — only takes write access away and drops the Write tokens.
 */
export function armLifecycleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/auth/arm/extend', { config: { rateLimit: ARM_RATE_LIMIT } }, async (request) => {
    const session = requireSessionWithCsrf(request);
    requireRole(session, 'Portal.Operator', 'Extending write access');
    const body = parseBody(ExtendRequest, request.body);
    const now = ctx.now();
    if (!isArmed(session, now)) throw notArmed();
    if (session.writeExtended) {
      throw new AppError(409, 'already_extended', 'Write access has already been extended once.', {
        hint: 'Disarm, then arm again to start a new write window.',
      });
    }
    const minutes = armMinutes(ctx, body.minutes ?? ctx.config.WRITE_SESSION_MAX_MINUTES);
    const until = new Date(Math.max(session.writeExpiresAt!.getTime(), now.getTime() + minutes * 60_000));
    const updated = (await ctx.sessions.update(session.idHash, {
      writeExpiresAt: until,
      writeExtended: true,
    }))!;
    await ctx.audit.append({
      ...auditActor(ctx, request, updated),
      action: 'session.arm_extended',
      result: 'success',
      details: {
        minutes,
        previousExpiry: session.writeExpiresAt!.toISOString(),
        armedUntil: until.toISOString(),
      },
    });
    return { armedUntil: until.toISOString(), armExtended: true };
  });

  app.post('/auth/disarm', { config: { rateLimit: ARM_RATE_LIMIT } }, async (request) => {
    const session = requireSessionWithCsrf(request);
    const wasArmed = isArmed(session, ctx.now());
    if (session.writeAccountId || session.writeExpiresAt) await dropWriteAccess(ctx, session);
    if (wasArmed) {
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        mode: 'write',
        action: 'session.disarmed',
        result: 'success',
        details: { armedUntil: session.writeExpiresAt!.toISOString() },
      });
    }
    return { mode: 'read' as const, armedUntil: null };
  });
}

/** Preconditions shared by both arm implementations. */
export function armPreconditions(request: Parameters<typeof requireSession>[0]): {
  session: SessionRecord;
  body: ArmRequest;
} {
  const session = requireSessionWithCsrf(request);
  requireRole(session, 'Portal.Operator', 'Arming write access');
  return { session, body: parseBody(ArmRequest, request.body) };
}

/**
 * Entra arm (AUTH_MODE=entra): POST /auth/arm returns the Write app's authorize URL; the browser
 * signs in again (auth-context step-up when WRITE_AUTH_CONTEXT is set, otherwise a fresh
 * interactive sign-in), and GET /auth/arm/callback opens the write window.
 */
export function entraArmRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = ctx.config;
  const auth = ctx.auth!;

  app.post<{ Querystring: { returnTo?: string } }>(
    '/auth/arm',
    { config: { rateLimit: ARM_RATE_LIMIT } },
    async (request, reply) => {
      const { session, body } = armPreconditions(request);
      if (!writeAppConfigured(cfg)) {
        throw new AppError(
          503,
          'write_app_not_configured',
          'Write access isn’t set up on this AdminForge installation.',
          {
            hint: 'An administrator needs to run `adminforge provision entra`, which creates the Write app (AF_WRITE_CLIENT_ID / AF_WRITE_CLIENT_SECRET).',
          },
        );
      }
      const { state, nonce, challenge } = await beginRoundTrip(ctx, {
        kind: 'write',
        binding: browserBinding(ctx, request, reply),
        returnTo: safeReturnTo(request.query.returnTo),
        sessionIdHash: session.idHash,
        details: { minutes: body.minutes, reason: body.reason },
      });
      // Always a fresh interactive sign-in (prompt=login, max_age=0) — with an auth context too: a Conditional Access
      // policy without "sign-in frequency: every time" could otherwise satisfy the context silently from SSO.
      const redirect = await auth.authUrl({
        kind: 'write',
        state,
        challenge,
        nonce,
        loginHint: session.upn,
        prompt: 'login',
        maxAge: 0,
        ...(cfg.WRITE_AUTH_CONTEXT ? { claims: authContextClaims(cfg.WRITE_AUTH_CONTEXT) } : {}),
      });
      return { redirect };
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    '/auth/arm/callback',
    { config: { rateLimit: ARM_RATE_LIMIT } },
    async (request, reply) => {
      const pending = await finishRoundTrip(ctx, 'write', request.query.state, request);
      const session = request.session;
      if (!session || session.idHash !== pending.sessionIdHash) {
        throw new AppError(
          401,
          'session_mismatch',
          'Write access was requested from a different sign-in session.',
          {
            hint: 'Your session changed while you were verifying (for example, you signed in again in another tab). Arm again from this tab.',
            login: '/auth/login?returnTo=%2F',
          },
        );
      }
      const reason = pending.details?.reason ?? null;
      const requested = pending.details?.minutes ?? cfg.WRITE_SESSION_MAX_MINUTES;
      const fail = async (err: AppError, details: Record<string, unknown> = {}) => {
        await ctx.audit.append({
          ...auditActor(ctx, request, session),
          action: 'session.armed',
          result: 'failure',
          details: { reason, error: err.code, ...details },
        });
        return err;
      };
      const entraError = providerError('write', request.query);
      if (entraError) {
        // Entra's description goes to the service log only; the audit log keeps allow-listed values.
        request.log.info(
          { entra: providerDescription(request.query) },
          'Entra returned a write sign-in error',
        );
        throw await fail(entraError, providerAuditDetails(request.query));
      }
      if (!request.query.code)
        throw await fail(
          new AppError(400, 'invalid_request', 'The verification response from Microsoft was incomplete.', {
            hint: 'You’re still signed in with read-only access. Arm again.',
          }),
        );
      if (!session.roles.includes('Portal.Operator'))
        throw await fail(
          new AppError(403, 'forbidden', 'Turning on write access needs the Operator role.', {
            hint: 'Ask a portal administrator to add you to the AdminForge Operator group.',
          }),
        );

      // S-08: arming gives the session a new id. The Write app redeems straight into the new id's partition, so write
      // tokens never exist under the old one; rotateSession below moves everything else.
      const sid = randomToken();
      const writePartition = partitionKey('write', sha256Hex(sid));
      let redeemed: Awaited<ReturnType<typeof auth.redeem>>;
      try {
        redeemed = await auth.redeem({
          kind: 'write',
          code: request.query.code,
          verifier: pending.verifier,
          nonce: pending.nonce,
          partitionKey: writePartition,
        });
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
          'write code redemption failed',
        );
        await ctx.tokenCache.delete(writePartition);
        throw await fail(
          new AppError(400, 'arm_failed', 'AdminForge couldn’t complete the write-access verification.', {
            hint: 'You’re still signed in with read-only access. Arm again. If it keeps happening, give a portal administrator the reference below.',
          }),
        );
      }
      const { claims, homeAccountId } = redeemed;
      const reject = async (err: AppError, details: Record<string, unknown> = {}) => {
        await auth.forget({ kind: 'write', partitionKey: writePartition });
        await ctx.tokenCache.delete(writePartition);
        return fail(err, details);
      };
      if (!claims.nonce || claims.nonce !== pending.nonce)
        throw await reject(
          new AppError(
            400,
            'invalid_nonce',
            'The verification response from Microsoft didn’t pass validation.',
            {
              hint: 'You’re still signed in with read-only access. Arm again.',
            },
          ),
        );
      if (claims.tid !== cfg.AF_TENANT_ID)
        throw await reject(
          new AppError(400, 'wrong_tenant', 'That account isn’t part of this organisation.', {
            hint: 'Arm again and verify with the same work account you signed in with.',
          }),
        );
      if (claims.oid !== session.userOid) {
        throw await reject(
          new AppError(
            403,
            'user_mismatch',
            'You verified with a different account than the one signed in.',
            { hint: 'Arm again and verify with the account shown in the top-right corner.' },
          ),
          {
            armedOid: claims.oid ?? null,
          },
        );
      }
      if (isGuestAccount(claims)) throw await reject(guestAccount());
      if (!hasAccountStatus(claims)) throw await reject(accountStatusMissing('write'));
      const acrs = acrsOf(claims);
      if (cfg.WRITE_AUTH_CONTEXT && !acrs.includes(cfg.WRITE_AUTH_CONTEXT)) {
        throw await reject(
          new AppError(
            403,
            'step_up_required',
            'Your verification didn’t meet the write-access sign-in policy.',
            {
              hint: 'Your organisation requires a stronger verification for write access (for example, phishing-resistant MFA or a compliant device). Arm again and complete every prompt.',
            },
          ),
          { acrs },
        );
      }
      const now = ctx.now();
      // The proof of a fresh sign-in is a recent auth_time — with or without an auth context: prompt=login travels in
      // a URL the browser controls, and an auth context can be satisfied from an earlier sign-in, so neither alone
      // may arm. Missing auth_time fails closed.
      if (typeof claims.auth_time !== 'number') {
        throw await reject(
          new AppError(403, 'step_up_unverified', 'AdminForge couldn’t confirm that you verified just now.', {
            hint: 'An administrator needs to run `adminforge provision entra` (it adds the auth_time claim to the Write app).',
          }),
        );
      }
      if (now.getTime() / 1000 - claims.auth_time > STEP_UP_MAX_AGE_SECONDS) {
        throw await reject(
          new AppError(403, 'step_up_stale', 'Write access needs a fresh verification.', {
            hint: 'Microsoft reused an earlier sign-in. Arm again and enter your credentials when asked.',
          }),
          { authAgeSeconds: Math.round(now.getTime() / 1000 - claims.auth_time) },
        );
      }

      const minutes = armMinutes(ctx, requested);
      const until = new Date(now.getTime() + minutes * 60_000);
      const patch = {
        writeAccountId: homeAccountId,
        writeExpiresAt: until,
        writeExtended: false,
        writeReason: reason,
      };
      let updated: SessionRecord | null;
      try {
        updated = await rotateSession(ctx, request, reply, session, patch, sid);
      } catch (err) {
        // Nothing moved (one transaction): the session stays read-only, and the Write tokens just redeemed go. The
        // logger's serializers keep a failed query's bound values (CSRF token, sealed blobs) out of the line.
        request.log.error({ err }, 'arming could not move the session to its new id');
        throw await reject(
          new AppError(500, 'arm_failed', 'AdminForge couldn’t turn on write access.', {
            hint: 'You’re still signed in with read-only access. Arm again. If it keeps happening, give a portal administrator the reference below.',
          }),
        );
      }
      // Signed out (in another tab) while verifying: nothing to arm.
      if (!updated) throw await reject(unauthenticated());
      await ctx.audit.append({
        ...auditActor(ctx, request, updated),
        action: 'session.armed',
        result: 'success',
        details: {
          minutes,
          requestedMinutes: requested,
          reason,
          armedUntil: until.toISOString(),
          stepUp: stepUpStrength(cfg),
          ...(acrs.length ? { acrs } : {}),
          sessionRotated: true,
        },
      });
      return reply.redirect(pending.returnTo);
    },
  );
}
