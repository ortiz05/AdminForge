import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditActor, type AppContext } from '../context';
import { AppError, parseBody } from '../errors';
import { grantPartition } from '../schedules/grants';
import { isDeleted } from '../schedules/service';
import type { ScheduleRow } from '../schedules/types';
import type { SchedulesModule } from '../schedules/module';
import {
  beginRoundTrip,
  browserBinding,
  providerAuditDetails,
  providerDescription,
  providerError,
  type CallbackQuery,
} from './flow';
import { requireRole, requireSessionWithCsrf } from './guards';
import { STEP_UP_MAX_AGE_SECONDS } from './arm-routes';
import type { PreauthRecord } from './preauth-store';
import { safeReturnTo } from './return-to';
import { portalRoles } from './roles';
import { hasAccountStatus, isGuestAccount } from './types';

/**
 * A schedule that runs with its creator's own access (ADR-014): the creator grants it, once per schedule, through a
 * fresh sign-in to the Read app. POST /auth/schedule-consent (CSRF, Portal.Operator, the creator only) returns the
 * authorize URL; the Read app's callback (/auth/callback, auth/routes.ts) hands a `schedule` round trip to
 * `completeScheduleConsent`, which seals the refresh token in the schedule's own token-cache partition and records the
 * grant. Nothing about the person's own session changes.
 */

const ConsentRequest = z.strictObject({ key: z.string().min(1).max(200) });

export const SCHEDULE_CONSENT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

const notCreator = () =>
  new AppError(403, 'not_schedule_creator', 'Only the person who created this schedule can sign in for it.', {
    hint: 'The schedule runs with its creator’s own access. Ask them to open it and sign in, or run it as the automation identity.',
  });

/** The schedule a grant is for: made in the portal and not deleted, set to run as its creator, created by `oid`. */
function grantable(s: ScheduleRow | null, oid: string): ScheduleRow {
  if (!s || isDeleted(s))
    throw new AppError(404, 'schedule_not_found', 'That schedule doesn’t exist any more.', {
      hint: 'Open Schedules and pick it again.',
    });
  const identity = s.definition.identity;
  if (identity === 'automation' || !('user' in identity))
    throw new AppError(
      409,
      'schedule_not_user_identity',
      'This schedule doesn’t run with its creator’s access, so there is nothing to sign in for.',
      { hint: 'Change “Run as” to “Me (my own access)” first.' },
    );
  if (s.source !== 'portal' || s.createdBy !== oid) throw notCreator();
  return s;
}

export function scheduleConsentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  schedules: () => SchedulesModule,
) {
  const auth = ctx.auth!;
  app.post<{ Querystring: { returnTo?: string } }>(
    '/auth/schedule-consent',
    { config: { rateLimit: SCHEDULE_CONSENT_RATE_LIMIT } },
    async (request, reply) => {
      const session = requireSessionWithCsrf(request);
      requireRole(session, 'Portal.Operator', 'Letting a schedule use your access');
      const { key } = parseBody(ConsentRequest, request.body);
      const s = grantable(await schedules().store.getSchedule(key), session.userOid);
      const { state, nonce, challenge } = await beginRoundTrip(ctx, {
        kind: 'schedule',
        binding: browserBinding(ctx, request, reply),
        returnTo: safeReturnTo(request.query.returnTo ?? `/schedules/${encodeURIComponent(s.key)}`),
        sessionIdHash: session.idHash,
        details: { scheduleId: s.id, scheduleKey: s.key },
      });
      // A deliberate, fresh sign-in: the person is handing a schedule long-lived read access, so single sign-on
      // must not do it silently (prompt=login, max_age=0; the callback checks auth_time, as arming does).
      const redirect = await auth.authUrl({
        kind: 'read',
        state,
        challenge,
        nonce,
        loginHint: session.upn,
        prompt: 'login',
        maxAge: 0,
      });
      return { redirect };
    },
  );
}

/** The callback half: `pending` is a `schedule` round trip finished by /auth/callback. */
export async function completeScheduleConsent(
  ctx: AppContext,
  schedules: SchedulesModule,
  request: FastifyRequest<{ Querystring: CallbackQuery }>,
  reply: FastifyReply,
  pending: PreauthRecord,
): Promise<FastifyReply> {
  const auth = ctx.auth!;
  const session = request.session;
  const scheduleId = pending.details?.scheduleId;
  const scheduleKey = pending.details?.scheduleKey ?? null;
  const fail = async (err: AppError, details: Record<string, unknown> = {}) => {
    await ctx.audit.append({
      ...auditActor(ctx, request, session ?? null),
      action: 'schedule.consented',
      targetType: 'schedule',
      targetId: scheduleKey,
      result: 'failure',
      details: { reason: err.code, ...details },
    });
    return err;
  };
  if (!session || session.idHash !== pending.sessionIdHash || !scheduleId)
    throw await fail(
      new AppError(
        401,
        'session_mismatch',
        'The sign-in for the schedule came back to a different session.',
        {
          hint: 'Your session changed while you were signing in (for example, in another tab). Open the schedule again and sign in from there.',
        },
      ),
    );
  const entraError = providerError('read', request.query);
  if (entraError) {
    request.log.info(
      { entra: providerDescription(request.query) },
      'Entra returned an error to a schedule sign-in',
    );
    throw await fail(entraError, providerAuditDetails(request.query));
  }
  if (!request.query.code)
    throw await fail(
      new AppError(400, 'invalid_request', 'The sign-in response from Microsoft was incomplete.', {
        hint: 'Open the schedule and sign in again.',
      }),
    );
  // Redeemed into a partition of its own and moved to the schedule's only on success, so a failed or refused sign-in
  // never touches a grant that still works (and nothing is left behind: the purge drops it as an orphan).
  const partitionKey = `schedule-pending:${randomUUID()}`;
  const forget = async () => {
    await auth.forget({ kind: 'read', partitionKey }).catch(() => undefined);
    await ctx.tokenCache.delete(partitionKey);
  };
  let redeemed: Awaited<ReturnType<typeof auth.redeem>>;
  try {
    redeemed = await auth.redeem({
      kind: 'read',
      code: request.query.code,
      verifier: pending.verifier,
      nonce: pending.nonce,
      partitionKey,
    });
  } catch (err) {
    request.log.warn(
      { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
      'schedule sign-in: code redemption failed',
    );
    await forget();
    throw await fail(
      new AppError(400, 'signin_failed', 'AdminForge couldn’t complete the sign-in for the schedule.', {
        hint: 'Open the schedule and sign in again. If it keeps happening, give a portal administrator the reference below.',
      }),
    );
  }
  const { claims, homeAccountId } = redeemed;
  const reject = async (err: AppError) => {
    await forget();
    return fail(err);
  };
  if (!claims.nonce || claims.nonce !== pending.nonce)
    throw await reject(
      new AppError(400, 'invalid_nonce', 'The sign-in response from Microsoft didn’t pass validation.', {
        hint: 'Open the schedule and sign in again. Nothing was changed.',
      }),
    );
  if (claims.tid !== ctx.config.AF_TENANT_ID || isGuestAccount(claims) || !hasAccountStatus(claims))
    throw await reject(
      new AppError(403, 'wrong_account', 'That account can’t be used for this schedule.', {
        hint: 'Sign in with your own work account in this organisation — the one that created the schedule.',
      }),
    );
  // The account that signed in must be the person whose session started it, and the schedule's creator.
  if (claims.oid !== session.userOid) throw await reject(notCreator());
  // prompt=login travels in a URL the browser controls: the proof of a fresh sign-in is a recent auth_time.
  const now = ctx.now();
  if (
    typeof claims.auth_time !== 'number' ||
    now.getTime() / 1000 - claims.auth_time > STEP_UP_MAX_AGE_SECONDS
  )
    throw await reject(
      new AppError(403, 'signin_not_fresh', 'Letting a schedule use your access needs a fresh sign-in.', {
        hint:
          typeof claims.auth_time !== 'number'
            ? 'An administrator needs to run `pnpm adminforge provision entra` (it adds the auth_time claim to the Read app). Then sign in for the schedule again.'
            : 'Microsoft reused an earlier sign-in. Open the schedule, choose Sign in again and enter your credentials when asked.',
      }),
    );
  let s: ScheduleRow;
  try {
    s = grantable(await schedules.store.getScheduleById(scheduleId), claims.oid);
  } catch (err) {
    throw await reject(err as AppError);
  }
  if (!portalRoles(claims).includes('Portal.Operator'))
    throw await reject(
      new AppError(
        403,
        'missing_role',
        'Schedules run with your access only while you hold Portal.Operator.',
        {
          hint: 'Ask a portal administrator to add you to the AdminForge Operator group.',
        },
      ),
    );
  const finalPartition = grantPartition(s.id);
  const cache = await ctx.tokenCache.get(partitionKey);
  if (!cache)
    throw await reject(
      new AppError(400, 'signin_failed', 'AdminForge couldn’t complete the sign-in for the schedule.', {
        hint: 'Open the schedule and sign in again. If it keeps happening, give a portal administrator the reference below.',
      }),
    );
  await ctx.tokenCache.set(finalPartition, cache);
  await ctx.tokenCache.delete(partitionKey);
  await schedules.identities.grants.put({
    scheduleId: s.id,
    userOid: claims.oid,
    upn: session.upn,
    homeAccountId,
    status: 'active',
    reason: null,
    consentedAt: now,
    checkedAt: now,
  });
  // Checked again after writing: a delete or a change of "Run as" that raced this sign-in removes the grant on its
  // side after its own write, and this re-read catches one that finished before the grant existed.
  try {
    grantable(await schedules.store.getScheduleById(s.id), claims.oid);
  } catch (err) {
    await schedules.identities.remove(s.id);
    throw await fail(err as AppError);
  }
  await ctx.audit.append({
    ...auditActor(ctx, request, session),
    action: 'schedule.consented',
    targetType: 'schedule',
    targetId: s.key,
    result: 'success',
    details: { scheduleId: s.id, version: s.definition.version, sha256: s.sha256 },
  });
  schedules.events.publish({ type: 'schedules.changed', data: { key: s.key } });
  return reply.redirect(pending.returnTo);
}
