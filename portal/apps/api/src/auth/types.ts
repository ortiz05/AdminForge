/** Which Entra app a token or sign-in belongs to: the Read app, or the Write app used while armed. */
export type AppKind = 'read' | 'write';

/** ID token claims the BFF relies on. */
export interface IdClaims {
  oid: string;
  tid: string;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  upn?: string;
  login_hint?: string;
  roles?: string[];
  /** Satisfied authentication contexts; Entra emits an array (older tokens: a single string). */
  acrs?: string[] | string;
  auth_time?: number;
}

export interface AuthUrlInput {
  kind: AppKind;
  state: string;
  /** PKCE S256 challenge. */
  challenge: string;
  nonce: string;
  loginHint?: string;
  /** Claims request JSON (CAE challenge or authentication-context step-up). */
  claims?: string;
  prompt?: 'login' | 'select_account' | 'consent' | 'none';
  /** OIDC max_age; 0 forces a fresh authentication. */
  maxAge?: number;
}

/**
 * Everything the BFF needs from the identity provider. The MSAL implementation lives in
 * msal-client.ts; tests use a fake. Tokens never leave this interface except as return values
 * handed straight to an outbound request.
 */
export interface AuthClient {
  authUrl(input: AuthUrlInput): Promise<string>;
  /** Redeems an authorization code; the token cache is written to `partitionKey`. */
  redeem(input: {
    kind: AppKind;
    code: string;
    verifier: string;
    nonce: string;
    partitionKey: string;
  }): Promise<{ homeAccountId: string; claims: IdClaims }>;
  /** Silent token for `scopes` from the partition's cache (refreshing when needed). */
  token(input: {
    kind: AppKind;
    partitionKey: string;
    homeAccountId: string;
    scopes: string[];
    forceRefresh?: boolean;
    claims?: string;
  }): Promise<string>;
  /** Drops everything cached for the partition. */
  forget(input: { kind: AppKind; partitionKey: string }): Promise<void>;
  /** Entra end-session URL. */
  logoutUrl(input: { postLogoutRedirectUri: string; logoutHint?: string }): string;
}

/** Silent token acquisition failed; the user must sign in (read) or re-arm (write) interactively. */
export class ReauthRequired extends Error {
  constructor(
    readonly kind: AppKind,
    /** Claims request JSON to pass to the interactive sign-in (CAE). */
    readonly claims?: string,
  ) {
    super(`Sign-in required for ${kind} access`);
    this.name = 'ReauthRequired';
  }
}

/** A write token was requested for a session that is not armed (or whose write window has ended). */
export class NotArmed extends Error {
  constructor(message = 'Write access is not armed for this session.') {
    super(message);
    this.name = 'NotArmed';
  }
}

export const partitionKey = (kind: AppKind, sessionIdHash: string) => `${kind}:${sessionIdHash}`;
