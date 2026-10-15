import { ArmRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAppConfigured } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import {
  acrsOf,
  authContextClaims,
  beginRoundTrip,
  finishRoundTrip,
  providerError,
  type CallbackQuery,
} from './flow';
import { requireRole, requireSession, requireSessionWithCsrf } from './guards';
import { safeReturnTo } from './return-to';
import { dropWriteAccess } from './session-plugin';
import { isArmed, type SessionRecord } from './session-store';
import { partitionKey } from './types';

export const ARM_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

/** Body of POST /auth/arm/extend. Without `minutes` the extension is WRITE_SESSION_MAX_MINUTES. */
export const ExtendRequest = z.object({ minutes: z.number().int().min(5).max(480).optional() });

/** The armed window: requested minutes capped by WRITE_SESSION_MAX_MINUTES. */
export const armMinutes = (ctx: AppContext, requested: number) =>
  Math.min(requested, ctx.config.WRITE_SESSION_MAX_MINUTES);

const notArmed = () =>
  new AppError(409, 'not_armed', 'Write access is not armed.', { hint: 'Arm write access first.' });

/** Extend (once per armed session) and disarm — identical in mock and Entra modes. */
export function armLifecycleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/auth/arm/extend', { config: { rateLimit: ARM_RATE_LIMIT } }, async (request) => {
    const session = requireSessionWithCsrf(request);
    const body = parseBody(ExtendRequest, request.body);
    const now = ctx.now();
    if (!isArmed(session, now)) throw notArmed();
    if (session.writeExtended) {
      throw new AppError(
        409,
        'already_extended',
        'Write access can be extended once. Disarm and arm again to continue.',
      );
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
    async (request) => {
      const { session, body } = armPreconditions(request);
      if (!writeAppConfigured(cfg)) {
        throw new AppError(
          503,
          'write_app_not_configured',
          'The Write app is not configured for this installation.',
          {
            hint: 'Run `adminforge provision entra` to create it (AF_WRITE_CLIENT_ID / AF_WRITE_CLIENT_SECRET).',
          },
        );
      }
      const { state, nonce, challenge } = await beginRoundTrip(ctx, {
        kind: 'write',
        returnTo: safeReturnTo(request.query.returnTo),
        sessionIdHash: session.idHash,
        details: { minutes: body.minutes, reason: body.reason },
      });
      const stepUp = cfg.WRITE_AUTH_CONTEXT
        ? { claims: authContextClaims(cfg.WRITE_AUTH_CONTEXT) }
        : // No auth context (needs Entra ID P1): force a fresh interactive sign-in instead.
          { prompt: 'login' as const, maxAge: 0 };
      const redirect = await auth.authUrl({
        kind: 'write',
        state,
        challenge,
        nonce,
        loginHint: session.upn,
        ...stepUp,
      });
      return { redirect };
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    '/auth/arm/callback',
    { config: { rateLimit: ARM_RATE_LIMIT } },
    async (request, reply) => {
      const pending = await finishRoundTrip(ctx, 'write', request.query.state);
      const session = request.session;
      if (!session || session.idHash !== pending.sessionIdHash) {
        throw new AppError(
          401,
          'session_mismatch',
          'Arming was started from a different session. Sign in and arm again.',
          { login: '/auth/login?returnTo=%2F' },
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
      const entraError = providerError('arm_failed', request.query);
      if (entraError) throw await fail(entraError);
      if (!request.query.code)
        throw await fail(
          new AppError(400, 'invalid_request', 'The step-up response had no authorization code.'),
        );
      if (!session.roles.includes('Portal.Operator'))
        throw await fail(
          new AppError(403, 'forbidden', 'Arming write access needs the Portal.Operator role.'),
        );

      const writePartition = partitionKey('write', session.idHash);
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
        throw await fail(new AppError(400, 'arm_failed', 'Write access could not be armed. Try again.'));
      }
      const { claims, homeAccountId } = redeemed;
      const reject = async (err: AppError, details: Record<string, unknown> = {}) => {
        await auth.forget({ kind: 'write', partitionKey: writePartition });
        await ctx.tokenCache.delete(writePartition);
        return fail(err, details);
      };
      if (!claims.nonce || claims.nonce !== pending.nonce)
        throw await reject(
          new AppError(400, 'invalid_nonce', 'Step-up response failed validation. Try again.'),
        );
      if (claims.tid !== cfg.AF_TENANT_ID)
        throw await reject(
          new AppError(400, 'wrong_tenant', 'This account belongs to a different Microsoft Entra tenant.'),
        );
      if (claims.oid !== session.userOid) {
        throw await reject(
          new AppError(
            403,
            'user_mismatch',
            'You armed with a different account than the one signed in. Arm again with your own account.',
          ),
          {
            armedOid: claims.oid ?? null,
          },
        );
      }
      const acrs = acrsOf(claims);
      if (cfg.WRITE_AUTH_CONTEXT && !acrs.includes(cfg.WRITE_AUTH_CONTEXT)) {
        throw await reject(
          new AppError(
            403,
            'step_up_required',
            'The sign-in did not satisfy the write-access Conditional Access requirement.',
          ),
          { acrs },
        );
      }
      const now = ctx.now();
      if (!cfg.WRITE_AUTH_CONTEXT && claims.auth_time && now.getTime() / 1000 - claims.auth_time > 600) {
        throw await reject(new AppError(403, 'step_up_stale', 'Arming needs a fresh sign-in. Try again.'));
      }

      const minutes = armMinutes(ctx, requested);
      const until = new Date(now.getTime() + minutes * 60_000);
      const updated = (await ctx.sessions.update(session.idHash, {
        writeAccountId: homeAccountId,
        writeExpiresAt: until,
        writeExtended: false,
        writeReason: reason,
      }))!;
      await ctx.audit.append({
        ...auditActor(ctx, request, updated),
        action: 'session.armed',
        result: 'success',
        details: {
          minutes,
          requestedMinutes: requested,
          reason,
          armedUntil: until.toISOString(),
          ...(acrs.length ? { acrs } : {}),
        },
      });
      return reply.redirect(pending.returnTo);
    },
  );
}
