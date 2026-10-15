import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfidentialClientApplication, LogLevel, type Configuration } from '@azure/msal-node';
import type { Config } from '../config';
import { AppError } from '../errors';

/**
 * App-only tokens for the automation identity (ADR-011): unattended schedules on this host.
 * Certificate (AF_AUTOMATION_CERT_PATH, PEM with certificate + private key) is preferred over the secret.
 * Tokens are cached in memory by MSAL (client-credential tokens are reused until shortly before expiry) and
 * are never logged or returned anywhere except straight into an outbound request.
 */
export interface AutomationTokenProvider {
  /** App-only token for `scope` (must be `<resource>/.default`). */
  token(scope: string, opts?: { forceRefresh?: boolean; claims?: string }): Promise<string>;
  readonly clientId: string;
  /** Which credential is configured (never its value). */
  readonly credential: 'certificate' | 'secret';
}

/** The slice of MSAL used here (tests inject a fake). */
export interface ClientCredentialClient {
  acquireTokenByClientCredential(request: { scopes: string[]; skipCache?: boolean; claims?: string }): Promise<{ accessToken: string } | null>;
}

export type AutomationConfig = Pick<Config, 'AF_TENANT_ID' | 'AF_AUTOMATION_CLIENT_ID' | 'AF_AUTOMATION_CLIENT_SECRET' | 'AF_AUTOMATION_CERT_PATH'>;

export interface AutomationOptions {
  createClient?: (config: Configuration) => ClientCredentialClient;
  readFile?: (path: string) => string;
  log?: { warn(obj: object, msg: string): void };
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/**
 * Certificate credential for MSAL from a PEM bundle: SHA-256 thumbprint (hex), PKCS#8 private key and x5c.
 * Throws a configuration error naming the file problem, never the key material.
 */
export function certificateCredential(pem: string): { thumbprintSha256: string; privateKey: string; x5c: string } {
  const blocks = [...pem.matchAll(PEM_BLOCK)].map((m) => ({ label: m[1]!, text: m[0] }));
  const cert = blocks.find((b) => b.label === 'CERTIFICATE');
  const key = blocks.find((b) => /PRIVATE KEY$/.test(b.label) && !/ENCRYPTED/.test(b.label));
  if (!cert || !key) {
    throw new AppError(503, 'automation_not_configured', 'AF_AUTOMATION_CERT_PATH must be a PEM file with the certificate and an unencrypted private key.', {
      hint: 'Combine them with: cat cert.pem key.pem > automation.pem (keep it outside the repo, mode 0600).',
    });
  }
  const x509 = new X509Certificate(cert.text);
  const privateKey = createPrivateKey(key.text).export({ type: 'pkcs8', format: 'pem' }).toString();
  return { thumbprintSha256: x509.fingerprint256.replace(/:/g, '').toLowerCase(), privateKey, x5c: x509.raw.toString('base64') };
}

/** Resource `.default` scope for an app-only token (function connections pass their audience). */
export const appOnlyScope = (resourceOrAudience: string) => {
  const base = resourceOrAudience.replace(/\/\.default$/, '').replace(/\/+$/, '');
  return `${base}/.default`;
};

/** Null when the automation identity is not configured (schedules and `fixtures record` then refuse with a hint). */
export function createAutomationTokenProvider(cfg: AutomationConfig, opts: AutomationOptions = {}): AutomationTokenProvider | null {
  const clientId = cfg.AF_AUTOMATION_CLIENT_ID;
  const tenantId = cfg.AF_TENANT_ID;
  if (!clientId || !tenantId || (!cfg.AF_AUTOMATION_CERT_PATH && !cfg.AF_AUTOMATION_CLIENT_SECRET)) return null;
  const credential: AutomationTokenProvider['credential'] = cfg.AF_AUTOMATION_CERT_PATH ? 'certificate' : 'secret';
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let client: ClientCredentialClient | undefined;

  const getClient = (): ClientCredentialClient => {
    if (client) return client;
    let auth: Configuration['auth'];
    if (cfg.AF_AUTOMATION_CERT_PATH) {
      let pem: string;
      try {
        pem = readFile(cfg.AF_AUTOMATION_CERT_PATH);
      } catch {
        throw new AppError(503, 'automation_not_configured', 'AF_AUTOMATION_CERT_PATH cannot be read.', { hint: 'Check the path and that this process may read the file.' });
      }
      auth = { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientCertificate: certificateCredential(pem) };
    } else {
      auth = { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, clientSecret: cfg.AF_AUTOMATION_CLIENT_SECRET! };
    }
    const config: Configuration = {
      auth,
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning) opts.log?.warn({ source: 'msal-automation' }, message);
          },
        },
      },
    };
    client = opts.createClient ? opts.createClient(config) : new ConfidentialClientApplication(config);
    return client;
  };

  return {
    clientId,
    credential,
    async token(scope, { forceRefresh, claims } = {}) {
      if (!scope.endsWith('/.default')) throw new Error(`App-only tokens need a /.default scope (got ${scope}).`);
      let result: { accessToken: string } | null;
      try {
        result = await getClient().acquireTokenByClientCredential({ scopes: [scope], ...(forceRefresh || claims ? { skipCache: true } : {}), ...(claims ? { claims } : {}) });
      } catch (err) {
        if (err instanceof AppError) throw err;
        // MSAL errors carry AADSTS codes; keep only the first line (no trace ids, never the credential).
        const text = (err as { errorMessage?: string; message?: string })?.errorMessage ?? (err as Error)?.message ?? String(err);
        const first = text.split(/\r?\n/)[0]!.replace(/Trace ID:.*$/i, '').trim();
        throw new AppError(502, 'automation_token_failed', `The automation identity could not get a token for ${scope}: ${first}`, {
          hint: 'Check AF_AUTOMATION_CLIENT_ID and its certificate/secret (adminforge provision status).',
        });
      }
      if (!result?.accessToken) throw new AppError(502, 'automation_token_failed', `The automation identity got no token for ${scope}.`);
      return result.accessToken;
    },
  };
}
