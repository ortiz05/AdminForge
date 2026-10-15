import { createGraphClient } from '@adminforge/connectors';
import { PORTAL_ROLES, type PortalRole } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { auditActor, type AppContext } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../security/tokens';
import { beginRoundTrip, decodeClaimsParam, finishRoundTrip, providerError, type CallbackQuery } from './flow';
import { safeReturnTo } from './return-to';
import { clearSessionCookie, endSession, startSession } from './session-plugin';
import { assertCsrf } from '../security/csrf';
import { partitionKey, type IdClaims } from './types';

export const AUTH_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };

/** Where Entra sends the browser after end-session (register it on the Read app). */
export const signedOutUri = (cfg: Pick<Config, 'PUBLIC_BASE_URL'>) => `${cfg.PUBLIC_BASE_URL}/auth/signed-out`;

const portalRoles = (claims: IdClaims): PortalRole[] =>
  (claims.roles ?? []).filter((r): r is PortalRole => (PORTAL_ROLES as readonly string[]).includes(r));

/** Tenant display name and default domain for the shell. Best effort: never blocks sign-in. */
async function tenantProfile(ctx: AppContext, homeAccountId: string, idHash: string): Promise<{ name: string; domain: string }> {
  const fallback = { name: ctx.config.AF_PRIMARY_DOMAIN ?? 'Microsoft Entra tenant', domain: ctx.config.AF_PRIMARY_DOMAIN ?? '' };
  if (!ctx.auth) return fallback;
  try {
    const token = await ctx.auth.token({ kind: 'read', partitionKey: partitionKey('read', idHash), homeAccountId, scopes: ['https://graph.microsoft.com/.default'] });
    const graph = createGraphClient({
      getToken: async () => token,
      fetch: ctx.fetch,
      maxRetries: 0,
      timeoutMs: 5_000,
    });
    const { data } = await graph.request<{ value?: Array<{ displayName?: string; verifiedDomains?: Array<{ name: string; isDefault?: boolean }> }> }>({
      path: '/organization',
      query: { $select: 'displayName,verifiedDomains' },
    });
    const org = data.value?.[0];
    const domain = org?.verifiedDomains?.find((d) => d.isDefault)?.name ?? fallback.domain;
    return { name: org?.displayName ?? fallback.name, domain };
  } catch {
    return fallback;
  }
}

/** Sign-out and the post-logout landing route, shared by mock and Entra modes. */
export function sessionEndRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/auth/logout', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const session = request.session;
    if (session) {
      assertCsrf(request);
      await endSession(ctx, session);
      await ctx.audit.append({ ...auditActor(ctx, request, session), action: 'session.signout', result: 'success' });
    }
    clearSessionCookie(ctx, reply);
    const redirect = ctx.auth ? ctx.auth.logoutUrl({ postLogoutRedirectUri: signedOutUri(ctx.config) }) : '/signed-out';
    return { redirect };
  });

  // Entra end-session lands here; the SPA renders /signed-out (it must not auto-redirect to sign-in).
  app.get('/auth/signed-out', async (_request, reply) => reply.redirect('/signed-out'));
}

/** Read sign-in with Entra (AUTH_MODE=entra). */
export function entraSignInRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = ctx.config;
  const auth = ctx.auth!;

  app.get<{ Querystring: { returnTo?: string; claims?: string } }>('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const returnTo = safeReturnTo(request.query.returnTo);
    const claims = decodeClaimsParam(request.query.claims);
    const { state, nonce, challenge } = await beginRoundTrip(ctx, { kind: 'read', returnTo });
    const url = await auth.authUrl({ kind: 'read', state, challenge, nonce, claims, loginHint: request.session?.upn });
    return reply.redirect(url);
  });

  app.get<{ Querystring: CallbackQuery }>('/auth/callback', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const pending = await finishRoundTrip(ctx, 'read', request.query.state);
    const fail = async (err: AppError, details: Record<string, unknown> = {}) => {
      await ctx.audit.append({ ...auditActor(ctx, request, null), action: 'session.signin', result: 'failure', details: { reason: err.code, ...details } });
      return err;
    };
    const entraError = providerError('signin_failed', request.query);
    if (entraError) throw await fail(entraError);
    if (!request.query.code) throw await fail(new AppError(400, 'invalid_request', 'The sign-in response had no authorization code.'));

    const sid = randomToken();
    const idHash = sha256Hex(sid);
    const readPartition = partitionKey('read', idHash);
    let redeemed: Awaited<ReturnType<typeof auth.redeem>>;
    try {
      redeemed = await auth.redeem({ kind: 'read', code: request.query.code, verifier: pending.verifier, nonce: pending.nonce, partitionKey: readPartition });
    } catch (err) {
      request.log.warn({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, 'code redemption failed');
      await ctx.tokenCache.delete(readPartition);
      throw await fail(new AppError(400, 'signin_failed', 'Sign-in could not be completed. Start again.', { login: '/auth/login?returnTo=%2F' }));
    }
    const { claims, homeAccountId } = redeemed;
    const reject = async (err: AppError) => {
      await auth.forget({ kind: 'read', partitionKey: readPartition });
      await ctx.tokenCache.delete(readPartition);
      return fail(err, { oid: claims.oid ?? null, tid: claims.tid ?? null });
    };
    if (!claims.nonce || claims.nonce !== pending.nonce) throw await reject(new AppError(400, 'invalid_nonce', 'Sign-in response failed validation. Start again.'));
    if (claims.tid !== cfg.AF_TENANT_ID) throw await reject(new AppError(400, 'wrong_tenant', 'This account belongs to a different Microsoft Entra tenant.'));
    if (!claims.oid) throw await reject(new AppError(400, 'invalid_token', 'Sign-in response has no user object id.'));
    const roles = portalRoles(claims);
    if (roles.length === 0) {
      throw await reject(new AppError(403, 'no_portal_role', 'Your account has no AdminForge role.', { hint: 'Ask a portal administrator to add you to an AdminForge group.' }));
    }

    // Never carry an earlier session into the new sign-in.
    if (request.session) await endSession(ctx, request.session);
    const upn = claims.preferred_username ?? claims.upn ?? claims.login_hint ?? '';
    const tenant = await tenantProfile(ctx, homeAccountId, idHash);
    const session = await startSession(
      ctx,
      request,
      reply,
      {
        userOid: claims.oid,
        upn,
        displayName: claims.name ?? upn,
        tenantId: claims.tid,
        tenantName: tenant.name,
        tenantDomain: tenant.domain,
        roles,
        readAccountId: homeAccountId,
      },
      sid,
    );
    await ctx.audit.append({ ...auditActor(ctx, request, session), action: 'session.signin', result: 'success', details: { roles } });
    return reply.redirect(pending.returnTo);
  });
}
