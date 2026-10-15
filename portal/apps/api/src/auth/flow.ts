import { CryptoProvider } from '@azure/msal-node';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import { randomToken } from '../security/tokens';
import { PREAUTH_TTL_MS, type PreauthDetails, type PreauthRecord } from './preauth-store';
import type { AppKind, IdClaims } from './types';

const crypto = new CryptoProvider();

/** Starts an authorization-code round trip: random state + nonce, PKCE pair, 10-minute single-use record. */
export async function beginRoundTrip(
  ctx: AppContext,
  input: { kind: AppKind; returnTo: string; sessionIdHash?: string | null; details?: PreauthDetails | null },
): Promise<{ state: string; nonce: string; challenge: string }> {
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const record: PreauthRecord = {
    state: randomToken(),
    kind: input.kind,
    verifier,
    nonce: randomToken(),
    returnTo: input.returnTo,
    sessionIdHash: input.sessionIdHash ?? null,
    details: input.details ?? null,
    expiresAt: new Date(ctx.now().getTime() + PREAUTH_TTL_MS),
  };
  await ctx.preauth.put(record);
  return { state: record.state, nonce: record.nonce, challenge };
}

const invalidState = () =>
  new AppError(400, 'invalid_state', 'Sign-in expired or was started in another tab. Start again.', { login: '/auth/login?returnTo=%2F' });

/** Consumes the pending record for `state` (single use) and checks kind and expiry. */
export async function finishRoundTrip(ctx: AppContext, kind: AppKind, state: unknown): Promise<PreauthRecord> {
  if (typeof state !== 'string' || state.length < 16 || state.length > 128) throw invalidState();
  const record = await ctx.preauth.take(state);
  if (!record || record.kind !== kind || record.expiresAt.getTime() <= ctx.now().getTime()) throw invalidState();
  return record;
}

/** Query parameters of an authorization response (response_mode=query). */
export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/** Entra error redirect → 400 with a short, single-line message (no trace noise). */
export function providerError(code: string, query: CallbackQuery): AppError | undefined {
  if (!query.error) return undefined;
  const description = (query.error_description ?? '').split(/\r?\n/)[0]!.replace(/\s+Trace ID:.*$/i, '').slice(0, 300);
  return new AppError(400, code, description || `Microsoft Entra returned ${query.error}.`, { hint: `Entra error: ${query.error.slice(0, 64)}` });
}

/** Acr values satisfied by the sign-in, normalised to an array. */
export const acrsOf = (claims: IdClaims): string[] =>
  Array.isArray(claims.acrs) ? claims.acrs : typeof claims.acrs === 'string' ? claims.acrs.split(/[\s,]+/).filter(Boolean) : [];

/** Claims request asking Entra to satisfy a Conditional Access authentication context (step-up). */
export const authContextClaims = (authContext: string) =>
  JSON.stringify({ id_token: { acrs: { essential: true, value: authContext } }, access_token: { acrs: { essential: true, value: authContext } } });

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
