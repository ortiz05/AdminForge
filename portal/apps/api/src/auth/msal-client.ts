import {
  ConfidentialClientApplication,
  DistributedCachePlugin,
  InteractionRequiredAuthError,
  LogLevel,
  ResponseMode,
  type AuthorizationUrlRequest,
} from '@azure/msal-node';
import type { Config } from '../config';
import { FixedPartition, type TokenCacheStore } from './token-cache';
import { ReauthRequired, type AppKind, type AuthClient, type IdClaims } from './types';

/** Scopes requested at sign-in. Graph `.default` = everything consented to the app (read or write split by app). */
const SIGN_IN_SCOPES = ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/.default'];

/**
 * OAuth errors from the token endpoint that mean the refresh token is dead and only an interactive sign-in helps:
 * disabled or deleted account, password reset, revoked sessions (AADSTS50057, 50173, 700082, …). MSAL raises these
 * as a plain ServerError (not InteractionRequiredAuthError) unless Entra adds a sub-error.
 */
const DEAD_GRANT = new Set(['invalid_grant', 'unauthorized_client']);

/** What a failed silent acquisition means: ReauthRequired when Entra wants the user back, else the original error. */
export function silentFailure(err: unknown, kind: AppKind, claims?: string): unknown {
  if (err instanceof InteractionRequiredAuthError) return new ReauthRequired(kind, claims);
  const code = (err as { errorCode?: unknown } | null | undefined)?.errorCode;
  if (typeof code === 'string' && DEAD_GRANT.has(code)) return new ReauthRequired(kind, claims);
  return err;
}

export interface MsalLogger {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

/**
 * MSAL Node implementation of AuthClient.
 * One ConfidentialClientApplication per call: the DistributedCachePlugin then loads exactly one
 * partition (read:<sha256(sid)> or write:<sha256(sid)>), so users' caches never mix in memory.
 */
/** The MSAL calls the AuthClient makes (a test seam: `createApp` replaces the real application). */
export type MsalApp = Pick<
  ConfidentialClientApplication,
  'getAuthCodeUrl' | 'acquireTokenByCode' | 'acquireTokenSilent' | 'getTokenCache'
>;

export function createMsalAuthClient(
  cfg: Config,
  cache: TokenCacheStore,
  log?: MsalLogger,
  opts: { createApp?: (kind: AppKind, partitionKey?: string) => MsalApp } = {},
): AuthClient {
  const authority = `https://login.microsoftonline.com/${cfg.AF_TENANT_ID}`;

  const credentials = (kind: AppKind) => {
    const clientId = kind === 'read' ? cfg.AF_READ_CLIENT_ID : cfg.AF_WRITE_CLIENT_ID;
    const clientSecret = kind === 'read' ? cfg.AF_READ_CLIENT_SECRET : cfg.AF_WRITE_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new Error(`The ${kind} app is not configured (AF_${kind.toUpperCase()}_CLIENT_ID / _SECRET).`);
    return { clientId, clientSecret };
  };

  const redirectUri = (kind: AppKind) =>
    `${cfg.PUBLIC_BASE_URL}${kind === 'read' ? '/auth/callback' : '/auth/arm/callback'}`;

  const app = (kind: AppKind, partitionKey?: string): MsalApp =>
    opts.createApp?.(kind, partitionKey) ??
    new ConfidentialClientApplication({
      auth: { ...credentials(kind), authority, clientCapabilities: ['CP1'] },
      cache: partitionKey
        ? { cachePlugin: new DistributedCachePlugin(cache, new FixedPartition(partitionKey)) }
        : undefined,
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning) log?.warn({ source: 'msal' }, message);
          },
        },
      },
    });

  return {
    async authUrl({ kind, state, challenge, nonce, loginHint, claims, prompt, maxAge }) {
      const request: AuthorizationUrlRequest = {
        scopes: SIGN_IN_SCOPES,
        redirectUri: redirectUri(kind),
        responseMode: ResponseMode.QUERY,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state,
        nonce,
        loginHint,
        claims,
        prompt,
        // MSAL uses `maxAge` only to validate auth_time; the authorize request needs the parameter itself.
        extraQueryParameters: maxAge !== undefined ? { max_age: String(maxAge) } : undefined,
      };
      return app(kind).getAuthCodeUrl(request);
    },

    async redeem({ kind, code, verifier, nonce, partitionKey }) {
      const result = await app(kind, partitionKey).acquireTokenByCode({
        code,
        codeVerifier: verifier,
        redirectUri: redirectUri(kind),
        scopes: SIGN_IN_SCOPES,
        nonce,
      });
      if (!result.account) throw new Error('Sign-in returned no account');
      return { homeAccountId: result.account.homeAccountId, claims: result.idTokenClaims as IdClaims };
    },

    async token({ kind, partitionKey, homeAccountId, scopes, forceRefresh, claims }) {
      const cca = app(kind, partitionKey);
      const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) throw new ReauthRequired(kind, claims);
      try {
        const result = await cca.acquireTokenSilent({
          account,
          scopes,
          forceRefresh: forceRefresh ?? Boolean(claims),
          claims,
        });
        return result.accessToken;
      } catch (err) {
        throw silentFailure(err, kind, claims);
      }
    },

    async refreshClaims({ kind, partitionKey, homeAccountId }) {
      const cca = app(kind, partitionKey);
      const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) throw new ReauthRequired(kind);
      try {
        // The refresh-token grant with openid returns a new ID token, so `roles` are re-evaluated by Entra.
        const result = await cca.acquireTokenSilent({ account, scopes: SIGN_IN_SCOPES, forceRefresh: true });
        return result.idTokenClaims as IdClaims;
      } catch (err) {
        throw silentFailure(err, kind);
      }
    },

    async forget({ partitionKey }) {
      await cache.delete(partitionKey);
    },

    logoutUrl({ postLogoutRedirectUri, logoutHint }) {
      const qs = new URLSearchParams({ post_logout_redirect_uri: postLogoutRedirectUri });
      if (logoutHint) qs.set('logout_hint', logoutHint);
      return `${authority}/oauth2/v2.0/logout?${qs.toString()}`;
    },
  };
}
