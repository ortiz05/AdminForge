import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../security/tokens';
import {
  beginRoundTrip,
  browserBinding,
  decodeClaimsParam,
  finishRoundTrip,
  providerAuditDetails,
  providerDescription,
  providerError,
  type CallbackQuery,
} from './flow';
import { safeReturnTo } from './return-to';
import { portalRoles } from './roles';
import { clearSessionCookie, endSession, startSession, type NewSession } from './session-plugin';
import type { SessionRecord } from './session-store';
import { signInRateLimit, SignInFailureAudits } from '../rate-limit';
import { completeScheduleConsent } from './schedule-consent';
import { assertCsrf } from '../security/csrf';
import { hasAccountStatus, isGuestAccount, partitionKey } from './types';

export const AUTH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };

/** A guest (B2B) account of this tenant: refused at sign-in and when arming (`acct` claim = 1). */
export const guestAccount = () =>
  new AppError(403, 'guest_account', 'You signed in with a guest account.', {
    hint: 'Sign in with your work account in this organisation; guest accounts can’t use AdminForge.',
  });

/**
 * The ID token has no `acct` claim, so AdminForge can't tell a member from a guest: refused (fail closed) until
 * provisioning adds the claim. A setup error, so the hint is for an administrator.
 */
export const accountStatusMissing = (kind: 'read' | 'write') =>
  new AppError(
    403,
    'account_status_missing',
    'AdminForge couldn’t confirm that your account is a member of this organisation.',
    {
      hint: `An administrator needs to run \`pnpm adminforge provision entra\` (it adds the acct claim to the AdminForge apps). Then ${kind === 'write' ? 'arm write access' : 'sign in'} again.`,
    },
  );

/** Where Entra sends the browser after end-session (register it on the Read app). */
export const signedOutUri = (cfg: Pick<Config, 'PUBLIC_BASE_URL'>) =>
  `${cfg.PUBLIC_BASE_URL}/auth/signed-out`;

/** How long the sign-in waits for the tenant's name before using the configured domain. */
const TENANT_PROFILE_TIMEOUT_MS = 5_000;

/**
 * Tenant display name and default domain for the shell. Best effort: never blocks sign-in (at most
 * TENANT_PROFILE_TIMEOUT_MS, then the configured domain). Read through the outbound executor as the person signing in
 * — their Read app, a read-mode GET — so it gets the request policy, a concurrency slot and its `microsoft call` line
 * like every other Microsoft call (S-26). `signingIn` is the session about to be created (not stored yet): the token
 * comes from the partition the sign-in just redeemed into.
 */
export async function tenantProfile(
  ctx: Pick<AppContext, 'config' | 'auth' | 'outbound'>,
  signingIn: SessionRecord,
  correlationId: string,
  timeoutMs = TENANT_PROFILE_TIMEOUT_MS,
): Promise<{ name: string; domain: string }> {
  const fallback = {
    name: ctx.config.AF_PRIMARY_DOMAIN ?? 'Microsoft Entra tenant',
    domain: ctx.config.AF_PRIMARY_DOMAIN ?? '',
  };
  if (!ctx.auth) return fallback;
  try {
    const { data } = await ctx.outbound.execute<{
      value?: Array<{ displayName?: string; verifiedDomains?: Array<{ name: string; isDefault?: boolean }> }>;
    }>(
      { kind: 'delegated', session: signingIn, mode: 'read' },
      {
        service: 'graph',
        method: 'GET',
        path: '/organization',
        query: { $select: 'displayName,verifiedDomains' },
        // Best effort: a throttled or failing Graph means the configured domain, not a longer sign-in.
        maxRetries: 0,
      },
      { correlationId, signal: AbortSignal.timeout(timeoutMs) },
    );
    const org = data?.value?.[0];
    const domain = org?.verifiedDomains?.find((d) => d.isDefault)?.name ?? fallback.domain;
    return { name: org?.displayName ?? fallback.name, domain };
  } catch {
    return fallback;
  }
}

/** The session a sign-in is about to create, for calls made before it is stored (tenantProfile). */
function signingInSession(data: NewSession, idHash: string, now: Date): SessionRecord {
  return {
    ...data,
    idHash,
    csrf: '',
    writeAccountId: null,
    writeExpiresAt: null,
    writeExtended: false,
    writeReason: null,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now,
    ip: null,
    userAgent: null,
  };
}

/** Sign-out and the post-logout landing route, shared by mock and Entra modes. */
export function sessionEndRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/auth/logout', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const session = request.session;
    if (session) {
      assertCsrf(request);
      await endSession(ctx, session);
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'session.signout',
        result: 'success',
      });
    }
    clearSessionCookie(ctx, reply);
    const redirect = ctx.auth
      ? ctx.auth.logoutUrl({ postLogoutRedirectUri: signedOutUri(ctx.config) })
      : '/signed-out';
    return { redirect };
  });

  // Entra end-session lands here; the SPA renders /signed-out (it must not auto-redirect to sign-in).
  app.get('/auth/signed-out', async (_request, reply) => reply.redirect('/signed-out'));
}

/** Read sign-in with Entra (AUTH_MODE=entra). */
export function entraSignInRoutes(app: FastifyInstance, ctx: AppContext) {
  const failureAudits = new SignInFailureAudits();
  const cfg = ctx.config;
  const auth = ctx.auth!;

  // `?account=choose` shows Entra's account picker (after a no-access or wrong-account sign-in).
  app.get<{ Querystring: { returnTo?: string; claims?: string; account?: string } }>(
    '/auth/login',
    // Per client address, whatever cookie comes with it (rate-limit.ts).
    { config: { rateLimit: signInRateLimit(ctx.config) } },
    async (request, reply) => {
      const returnTo = safeReturnTo(request.query.returnTo);
      const claims = decodeClaimsParam(request.query.claims);
      const choose = request.query.account === 'choose';
      const { state, nonce, challenge } = await beginRoundTrip(ctx, {
        kind: 'read',
        returnTo,
        binding: browserBinding(ctx, request, reply),
        address: request.ip,
      });
      const url = await auth.authUrl({
        kind: 'read',
        state,
        challenge,
        nonce,
        claims,
        ...(choose ? { prompt: 'select_account' as const } : { loginHint: request.session?.upn }),
      });
      return reply.redirect(url);
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    '/auth/callback',
    { config: { rateLimit: signInRateLimit(ctx.config) } },
    async (request, reply) => {
      // The Read app's callback also finishes a schedule's grant (ADR-014): its own flow, the session unchanged.
      const pending = await finishRoundTrip(ctx, ['read', 'schedule'], request.query.state, request);
      if (pending.kind === 'schedule')
        return completeScheduleConsent(ctx, app.schedules, request, reply, pending);
      const fail = async (err: AppError, details: Record<string, unknown> = {}) => {
        // Anyone can send a browser here with an error: at most a few failure events per address and minute.
        const turn = failureAudits.next(request.ip);
        if (turn.write)
          await ctx.audit.append({
            ...auditActor(ctx, request, null),
            action: 'session.signin',
            result: 'failure',
            details: {
              reason: err.code,
              ...details,
              ...(turn.suppressed ? { suppressed: turn.suppressed } : {}),
            },
          });
        return err;
      };
      const entraError = providerError('read', request.query);
      if (entraError) {
        // Anyone can send a browser here with any error text: Entra's description goes to the service log only, and
        // the audit log keeps allow-listed values (the OAuth error and the AADSTS number).
        request.log.info({ entra: providerDescription(request.query) }, 'Entra returned a sign-in error');
        throw await fail(entraError, providerAuditDetails(request.query));
      }
      if (!request.query.code)
        throw await fail(
          new AppError(400, 'invalid_request', 'The sign-in response from Microsoft was incomplete.', {
            hint: 'Sign in again.',
            login: '/auth/login?returnTo=%2F',
          }),
        );

      const sid = randomToken();
      const idHash = sha256Hex(sid);
      const readPartition = partitionKey('read', idHash);
      let redeemed: Awaited<ReturnType<typeof auth.redeem>>;
      try {
        redeemed = await auth.redeem({
          kind: 'read',
          code: request.query.code,
          verifier: pending.verifier,
          nonce: pending.nonce,
          partitionKey: readPartition,
        });
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
          'code redemption failed',
        );
        await ctx.tokenCache.delete(readPartition);
        throw await fail(
          new AppError(400, 'signin_failed', 'AdminForge couldn’t complete your sign-in with Microsoft.', {
            hint: 'Sign in again. If it keeps happening, give a portal administrator the reference below.',
            login: '/auth/login?returnTo=%2F',
          }),
        );
      }
      const { claims, homeAccountId } = redeemed;
      const reject = async (err: AppError) => {
        await auth.forget({ kind: 'read', partitionKey: readPartition });
        await ctx.tokenCache.delete(readPartition);
        return fail(err, { oid: claims.oid ?? null, tid: claims.tid ?? null });
      };
      if (!claims.nonce || claims.nonce !== pending.nonce)
        throw await reject(
          new AppError(400, 'invalid_nonce', 'The sign-in response from Microsoft didn’t pass validation.', {
            hint: 'Sign in again. Nothing was changed.',
          }),
        );
      if (claims.tid !== cfg.AF_TENANT_ID)
        throw await reject(
          new AppError(400, 'wrong_tenant', 'That account isn’t part of this organisation.', {
            hint: 'Sign in with your work account for this organisation.',
          }),
        );
      if (!claims.oid)
        throw await reject(
          new AppError(
            400,
            'invalid_token',
            'Microsoft didn’t identify your account in the sign-in response.',
            {
              hint: 'Sign in again with your own account in this organisation. Guest accounts can’t use AdminForge.',
            },
          ),
        );
      if (isGuestAccount(claims)) throw await reject(guestAccount());
      if (!hasAccountStatus(claims)) throw await reject(accountStatusMissing('read'));
      const roles = portalRoles(claims);
      if (roles.length === 0) {
        throw await reject(
          new AppError(403, 'no_portal_role', 'Your account doesn’t have access to AdminForge yet.', {
            hint: 'Ask a portal administrator to add you to an AdminForge group: Reader to view, Operator to make changes.',
          }),
        );
      }

      // Never carry an earlier session into the new sign-in.
      if (request.session) await endSession(ctx, request.session);
      const upn = claims.preferred_username ?? claims.upn ?? claims.login_hint ?? '';
      const data: NewSession = {
        userOid: claims.oid,
        upn,
        displayName: claims.name ?? upn,
        tenantId: claims.tid,
        tenantName: '',
        tenantDomain: '',
        roles,
        readAccountId: homeAccountId,
      };
      const tenant = await tenantProfile(ctx, signingInSession(data, idHash, ctx.now()), request.id);
      const session = await startSession(
        ctx,
        request,
        reply,
        { ...data, tenantName: tenant.name, tenantDomain: tenant.domain },
        sid,
      );
      await ctx.audit.append({
        ...auditActor(ctx, request, session),
        action: 'session.signin',
        result: 'success',
        details: { roles },
      });
      return reply.redirect(pending.returnTo);
    },
  );
}
