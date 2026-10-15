import { ApiError, type Mode, type ServiceId, type TokenProvider } from '@adminforge/connectors';
import type { Config } from '../config';
import { AppError } from '../errors';
import { isArmed, type SessionRecord } from './session-store';
import { NotArmed, partitionKey, ReauthRequired, type AuthClient } from './types';

/** Services whose tokens the broker mints from the user's session (functions and the runner have their own audiences). */
export type BrokerService = Exclude<ServiceId, 'function' | 'runner'>;

/** Resource scopes per service (`.default` = everything consented to the Read or Write app for that resource). */
export const resourceScopes = (cfg: Pick<Config, 'AF_SPO_TENANT_NAME'>): Record<BrokerService, string[] | undefined> => ({
  graph: ['https://graph.microsoft.com/.default'],
  arm: ['https://management.azure.com/.default'],
  logAnalytics: ['https://api.loganalytics.io/.default'],
  exchange: ['https://outlook.office365.com/.default'],
  // Skype and Teams Tenant Admin API (first-party app id, the same in every tenant).
  teams: ['48ac35b8-9aa8-4d74-927d-1f4a14a0b239/.default'],
  sharepointAdmin: cfg.AF_SPO_TENANT_NAME ? [`https://${cfg.AF_SPO_TENANT_NAME}-admin.sharepoint.com/.default`] : undefined,
});

/** Base64 claims from WWW-Authenticate → the JSON MSAL expects. */
export function decodeClaimsChallenge(claims: string): string | undefined {
  try {
    const json = Buffer.from(claims, 'base64').toString('utf8');
    JSON.parse(json);
    return json;
  } catch {
    return undefined;
  }
}

export interface TokenRequestOptions {
  /** Claims request (JSON) from a CAE challenge; forces a refresh carrying those claims. */
  claims?: string;
  forceRefresh?: boolean;
}

/**
 * Hands out delegated tokens for the signed-in user. Read mode uses the Read app's account; write
 * mode uses the Write app's account and only while the session is armed. Tokens are never logged.
 */
export class TokenBroker {
  private readonly scopes: Record<BrokerService, string[] | undefined>;

  constructor(
    private readonly auth: AuthClient,
    cfg: Pick<Config, 'AF_SPO_TENANT_NAME'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.scopes = resourceScopes(cfg);
  }

  async get(session: SessionRecord, service: BrokerService, mode: Mode, opts: TokenRequestOptions = {}): Promise<string> {
    const scopes = this.scopes[service];
    if (!scopes) {
      throw new AppError(503, 'service_not_configured', `${service} is not configured for this installation.`, {
        hint: service === 'sharepointAdmin' ? 'Set AF_SPO_TENANT_NAME in the AdminForge env file.' : undefined,
      });
    }
    if (mode === 'write') {
      if (!isArmed(session, this.now())) throw new NotArmed();
      return this.auth.token({
        kind: 'write',
        partitionKey: partitionKey('write', session.idHash),
        homeAccountId: session.writeAccountId!,
        scopes,
        ...opts,
      });
    }
    if (!session.readAccountId) throw new ReauthRequired('read', opts.claims);
    return this.auth.token({ kind: 'read', partitionKey: partitionKey('read', session.idHash), homeAccountId: session.readAccountId, scopes, ...opts });
  }

  /** A connectors TokenProvider bound to one session/service/mode (prefer withToken, which also handles CAE). */
  provider(session: SessionRecord, service: BrokerService, mode: Mode, opts: TokenRequestOptions = {}): TokenProvider {
    return () => this.get(session, service, mode, opts);
  }

  /**
   * Runs `call` with a token provider and handles a Continuous Access Evaluation claims challenge:
   * a 401 carrying `claims` is retried once with a token minted for those claims; if that needs
   * interaction, ReauthRequired (with the claims) surfaces as 401 {reauth:{url}}.
   *
   * The token is acquired before `call` runs, so token errors (ReauthRequired, NotArmed) surface
   * as themselves instead of being treated as transport failures by an HTTP client's retry loop.
   */
  async withToken<T>(session: SessionRecord, service: BrokerService, mode: Mode, call: (getToken: TokenProvider) => Promise<T>): Promise<T> {
    const attempt = async (opts: TokenRequestOptions) => {
      const token = await this.get(session, service, mode, opts);
      return call(async () => token);
    };
    try {
      return await attempt({});
    } catch (err) {
      const claims = err instanceof ApiError && err.status === 401 && err.claims ? decodeClaimsChallenge(err.claims) : undefined;
      if (!claims) throw err;
      try {
        return await attempt({ claims });
      } catch (retryErr) {
        if (retryErr instanceof ApiError && retryErr.status === 401 && retryErr.claims) {
          throw new ReauthRequired(mode === 'write' ? 'write' : 'read', decodeClaimsChallenge(retryErr.claims) ?? claims);
        }
        throw retryErr;
      }
    }
  }
}
