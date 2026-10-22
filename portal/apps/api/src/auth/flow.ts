import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CryptoProvider } from '@azure/msal-node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import { addressKey } from '../rate-limit';
import { randomToken, sha256Hex } from '../security/tokens';
import { sessionCookieName, sessionCookieOptions } from './session-plugin';
import { PREAUTH_TTL_MS, type PreauthDetails, type PreauthKind, type PreauthRecord } from './preauth-store';
import type { IdClaims } from './types';

const crypto = new CryptoProvider();

/** The browser-binding cookie: random, per browser, HttpOnly; its hash ties a round trip to the browser that began it. */
export const bindingCookieName = (cfg: AppContext['config']) => `${sessionCookieName(cfg)}-pre`;

/**
 * The browser's binding value, created (and refreshed) when a round trip starts. Without it, a callback URL captured
 * from someone else's sign-in could be completed in a victim's browser (login CSRF / session swap).
 */
export function browserBinding(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): string {
  const name = bindingCookieName(ctx.config);
  const existing = request.cookies[name];
  const value = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
  reply.setCookie(name, value, { ...sessionCookieOptions(ctx.config), maxAge: 24 * 3600 });
  return value;
}

/** Starts an authorization-code round trip: random state + nonce, PKCE pair, 10-minute single-use record. */
/**
 * A sign-in's address, pseudonymous: keyed with a secret of this process, so a stored value can't be turned back into
 * an address by trying them all (pending sign-ins live ten minutes; a restart only splits one address's count).
 */
const ADDRESS_KEY = randomBytes(32);
export const addressHash = (ip: string) =>
  createHmac('sha256', ADDRESS_KEY).update(addressKey(ip)).digest('hex');

export async function beginRoundTrip(
  ctx: AppContext,
  input: {
    kind: PreauthKind;
    returnTo: string;
    /** browserBinding() of the request that starts it. */
    binding: string;
    sessionIdHash?: string | null;
    details?: PreauthDetails | null;
    /** A sign-in's client address (`request.ip`): its share of the pending sign-ins. */
    address?: string;
  },
): Promise<{ state: string; nonce: string; challenge: string }> {
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const record: PreauthRecord = {
    state: randomToken(),
    kind: input.kind,
    verifier,
    nonce: randomToken(),
    returnTo: input.returnTo,
    sessionIdHash: input.sessionIdHash ?? null,
    bindingHash: sha256Hex(input.binding),
    addressHash: input.address ? addressHash(input.address) : null,
    details: input.details ?? null,
    expiresAt: new Date(ctx.now().getTime() + PREAUTH_TTL_MS),
  };
  await ctx.preauth.put(record);
  return { state: record.state, nonce: record.nonce, challenge };
}

const invalidState = () =>
  new AppError(400, 'invalid_state', 'This sign-in link has expired or was already used.', {
    hint: 'Sign-ins time out after 10 minutes and work once, in the tab that started them. Start again from AdminForge.',
    login: '/auth/login?returnTo=%2F',
  });

/**
 * Consumes the pending record for `state` (single use) and checks kind, expiry and the browser binding. `kind` may
 * list several kinds that share a callback (the Read app's: sign-in and a schedule's grant).
 */
export async function finishRoundTrip(
  ctx: AppContext,
  kind: PreauthKind | readonly PreauthKind[],
  state: unknown,
  request: FastifyRequest,
): Promise<PreauthRecord> {
  if (typeof state !== 'string' || state.length < 16 || state.length > 128) throw invalidState();
  const record = await ctx.preauth.take(state);
  const kinds: readonly PreauthKind[] = typeof kind === 'string' ? [kind] : kind;
  if (!record || !kinds.includes(record.kind) || record.expiresAt.getTime() <= ctx.now().getTime())
    throw invalidState();
  const binding = request.cookies[bindingCookieName(ctx.config)];
  const expected = Buffer.from(record.bindingHash ?? '', 'utf8');
  const actual = Buffer.from(binding ? sha256Hex(binding) : '', 'utf8');
  if (!record.bindingHash || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw invalidState();
  return record;
}

export { providerAuditDetails, providerDescription, providerError, type CallbackQuery } from './entra-errors';

/** Acr values satisfied by the sign-in, normalised to an array. */
export const acrsOf = (claims: IdClaims): string[] =>
  Array.isArray(claims.acrs)
    ? claims.acrs
    : typeof claims.acrs === 'string'
      ? claims.acrs.split(/[\s,]+/).filter(Boolean)
      : [];

/** Claims request asking Entra to satisfy a Conditional Access authentication context (step-up). */
export const authContextClaims = (authContext: string) =>
  JSON.stringify({
    id_token: { acrs: { essential: true, value: authContext } },
    access_token: { acrs: { essential: true, value: authContext } },
  });

/** Decodes the `claims` query parameter of /auth/login (base64/base64url JSON from a CAE challenge). */
export function decodeClaimsParam(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    JSON.parse(json);
    return json;
  } catch {
    return undefined;
  }
}
