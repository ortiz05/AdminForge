import { createHash } from 'node:crypto';
import type { TokenProvider } from '@adminforge/connectors';

export interface ClientCredentials {
  tenantId: string;
  clientId: string;
  /** Exactly one of clientSecret / clientAssertion (certificate, RFC 7523). */
  clientSecret?: string;
  /** Builds a signed client assertion for the token endpoint (see provision/certificate.ts). */
  clientAssertion?: (tokenEndpoint: string) => string;
}

export interface ClientCredentialOptions extends ClientCredentials {
  /** e.g. https://graph.microsoft.com/.default */
  scope: string;
  fetch?: typeof fetch;
  authority?: string;
  now?: () => number;
}

/** Thrown when Entra refuses a token request. Carries the AADSTS code only — never the secret or token. */
export class TokenError extends Error {
  constructor(
    readonly error: string,
    readonly aadsts: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * Client-credentials token provider (OAuth 2.0 v2 endpoint). Caches the token until a minute before expiry.
 * Tokens are returned to the caller only; nothing here logs them.
 */
export function clientCredentialToken(opts: ClientCredentialOptions): TokenProvider {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const authority = opts.authority ?? 'https://login.microsoftonline.com';
  let cached: { token: string; expiresAt: number } | undefined;

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.token;
    const endpoint = `${authority}/${encodeURIComponent(opts.tenantId)}/oauth2/v2.0/token`;
    const credential: Record<string, string> = opts.clientAssertion
      ? {
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: opts.clientAssertion(endpoint),
        }
      : { client_secret: opts.clientSecret ?? '' };
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        ...credential,
        scope: opts.scope,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const aadsts = /AADSTS\d+/.exec(body.error_description ?? '')?.[0];
      const firstLine = (body.error_description ?? '')
        .split(/\r?\n/)[0]
        ?.replace(/Trace ID:.*$/, '')
        .trim();
      throw new TokenError(
        body.error ?? `HTTP${res.status}`,
        aadsts,
        `Token request for ${opts.scope} failed: ${firstLine || body.error || res.status}`,
      );
    }
    cached = {
      token: body.access_token,
      expiresAt: now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return cached.token;
  };
}

/** Decodes a JWT payload without verifying it (used only to inspect our own tokens' claims). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The `roles` claim of an access token (application permissions), sorted. */
export function tokenRoles(token: string): string[] {
  const roles = decodeJwtPayload(token).roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string').sort() : [];
}

export interface AuthorizeUrlInput {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  authority?: string;
}

/** Authorization-code + PKCE (S256) request URL for a delegated sign-in. */
export function buildAuthorizeUrl(i: AuthorizeUrlInput): string {
  const url = new URL(
    `${i.authority ?? 'https://login.microsoftonline.com'}/${encodeURIComponent(i.tenantId)}/oauth2/v2.0/authorize`,
  );
  url.search = new URLSearchParams({
    client_id: i.clientId,
    response_type: 'code',
    redirect_uri: i.redirectUri,
    response_mode: 'query',
    scope: i.scopes.join(' '),
    state: i.state,
    code_challenge: i.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** S256 PKCE challenge for a verifier. */
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Pure: problems with an authorize URL (empty = well-formed). Never echoes the URL itself. */
export function checkAuthorizeUrl(
  raw: string,
  expect: { tenantId: string; clientId: string; redirectUri: string },
): string[] {
  const problems: string[] = [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['not a valid URL'];
  }
  const p = url.searchParams;
  if (url.protocol !== 'https:') problems.push('authority is not https');
  if (url.pathname !== `/${expect.tenantId}/oauth2/v2.0/authorize`)
    problems.push('path is not /<tenant>/oauth2/v2.0/authorize');
  if (p.get('client_id') !== expect.clientId) problems.push('client_id does not match the Read app');
  if (p.get('response_type') !== 'code') problems.push('response_type is not code');
  if (p.get('redirect_uri') !== expect.redirectUri)
    problems.push('redirect_uri does not match the registered callback');
  if (!(p.get('scope') ?? '').split(' ').includes('openid')) problems.push('scope lacks openid');
  if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? ''))
    problems.push('PKCE S256 challenge missing or malformed');
  if (!p.get('state')) problems.push('state missing');
  return problems;
}
