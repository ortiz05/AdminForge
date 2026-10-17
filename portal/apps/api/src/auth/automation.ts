import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfidentialClientApplication, LogLevel, type Configuration } from '@azure/msal-node';
import { identityEnvPrefix } from '@adminforge/schemas';
import type { AppIdentityConfig, Config } from '../config';
import { AppError } from '../errors';

/**
 * App-only tokens for the automation identity (ADR-011) and the named app identities schedules may run as (ADR-014):
 * unattended work on this host. A certificate (…_CERT_PATH, PEM with certificate + private key) is preferred over the
 * secret. Tokens are cached in memory by MSAL (client-credential tokens are reused until shortly before expiry), one
 * client per identity, and are never logged or returned anywhere except straight into an outbound request.
 */
export interface AutomationTokenProvider {
  /** App-only token for `scope` (must be `<resource>/.default`). */
  token(scope: string, opts?: { forceRefresh?: boolean; claims?: string }): Promise<string>;
  readonly clientId: string;
  /** Which credential is configured (never its value). */
  readonly credential: 'certificate' | 'secret';
  /** The named app identity this provider is for; absent for the automation identity. */
  readonly identity?: string;
}

/** The automation identity and every named app identity, by name (ADR-014). */
export interface AppIdentityRegistry {
  /** The automation identity (no name) or the named app identity; null when it isn't configured. */
  get(name?: string): AutomationTokenProvider | null;
  /** Names of the configured app identities (AF_SCHEDULE_IDENTITIES). */
  names(): string[];
  /** Application ids of every app-only identity (protected from changes by playbooks). */
  clientIds(): string[];
}

/** The slice of MSAL used here (tests inject a fake). */
export interface ClientCredentialClient {
  acquireTokenByClientCredential(request: {
    scopes: string[];
    skipCache?: boolean;
    claims?: string;
  }): Promise<{ accessToken: string } | null>;
}

export type AutomationConfig = Pick<
  Config,
  'AF_TENANT_ID' | 'AF_AUTOMATION_CLIENT_ID' | 'AF_AUTOMATION_CLIENT_SECRET' | 'AF_AUTOMATION_CERT_PATH'
>;

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
export function certificateCredential(
  pem: string,
  setting = 'AF_AUTOMATION_CERT_PATH',
): {
  thumbprintSha256: string;
  privateKey: string;
  x5c: string;
} {
  const blocks = [...pem.matchAll(PEM_BLOCK)].map((m) => ({ label: m[1]!, text: m[0] }));
  const cert = blocks.find((b) => b.label === 'CERTIFICATE');
  const key = blocks.find((b) => /PRIVATE KEY$/.test(b.label) && !/ENCRYPTED/.test(b.label));
  if (!cert || !key) {
    throw new AppError(
      503,
      'automation_not_configured',
      `${setting} must be a PEM file with the certificate and an unencrypted private key.`,
      {
        hint: 'Combine them with: cat cert.pem key.pem > automation.pem (keep it outside the repo, mode 0600).',
      },
    );
  }
  const x509 = new X509Certificate(cert.text);
  const privateKey = createPrivateKey(key.text).export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    thumbprintSha256: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
    privateKey,
    x5c: x509.raw.toString('base64'),
  };
}

/** Resource `.default` scope for an app-only token (function connections pass their audience). */
export const appOnlyScope = (resourceOrAudience: string) => {
  const base = resourceOrAudience.replace(/\/\.default$/, '').replace(/\/+$/, '');
  return `${base}/.default`;
};

/** Null when the automation identity is not configured (schedules and `fixtures record` then refuse with a hint). */
export function createAutomationTokenProvider(
  cfg: AutomationConfig,
  opts: AutomationOptions = {},
): AutomationTokenProvider | null {
  if (!cfg.AF_AUTOMATION_CLIENT_ID || !cfg.AF_TENANT_ID) return null;
  return createAppTokenProvider(
    {
      tenantId: cfg.AF_TENANT_ID,
      clientId: cfg.AF_AUTOMATION_CLIENT_ID,
      certPath: cfg.AF_AUTOMATION_CERT_PATH,
      clientSecret: cfg.AF_AUTOMATION_CLIENT_SECRET,
    },
    opts,
  );
}

/** Every app-only identity of this installation: the automation identity plus AF_SCHEDULE_IDENTITIES. */
export function createAppIdentityRegistry(
  cfg: AutomationConfig & Pick<Config, 'SCHEDULE_IDENTITIES'>,
  opts: AutomationOptions & { automation?: AutomationTokenProvider | null } = {},
): AppIdentityRegistry {
  const automation =
    opts.automation !== undefined ? opts.automation : createAutomationTokenProvider(cfg, opts);
  const named = new Map<string, AutomationTokenProvider>();
  for (const id of cfg.SCHEDULE_IDENTITIES ?? []) {
    const p = cfg.AF_TENANT_ID
      ? createAppTokenProvider({ tenantId: cfg.AF_TENANT_ID, ...id, identity: id }, opts)
      : null;
    if (p) named.set(id.name, p);
  }
  return {
    get: (name) => (name ? (named.get(name) ?? null) : automation),
    names: () => [...named.keys()],
    clientIds: () =>
      [automation?.clientId, ...[...named.values()].map((p) => p.clientId)].filter((v): v is string => !!v),
  };
}

/** A token provider for one app registration; null without a credential. */
export function createAppTokenProvider(
  input: {
    tenantId: string;
    clientId: string;
    certPath?: string;
    clientSecret?: string;
    /** A named app identity (ADR-014); absent for the automation identity. */
    identity?: Pick<AppIdentityConfig, 'name'>;
  },
  opts: AutomationOptions = {},
): AutomationTokenProvider | null {
  const { clientId, tenantId, certPath, clientSecret } = input;
  const name = input.identity?.name;
  if (!certPath && !clientSecret) return null;
  // What errors call it and which keys they point at (names only, never values).
  const who = name ? `The app identity ${name}` : 'The automation identity';
  const keys = name ? identityEnvPrefix(name) : 'AF_AUTOMATION_';
  const credential: AutomationTokenProvider['credential'] = certPath ? 'certificate' : 'secret';
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let client: ClientCredentialClient | undefined;

  const getClient = (): ClientCredentialClient => {
    if (client) return client;
    let auth: Configuration['auth'];
    if (certPath) {
      let pem: string;
      try {
        pem = readFile(certPath);
      } catch {
        throw new AppError(503, 'automation_not_configured', `${keys}CERT_PATH cannot be read.`, {
          hint: 'Check the path and that this process may read the file.',
        });
      }
      auth = {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientCertificate: certificateCredential(pem, `${keys}CERT_PATH`),
      };
    } else {
      auth = {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret: clientSecret!,
      };
    }
    const config: Configuration = {
      auth,
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning)
              opts.log?.warn({ source: 'msal-automation', ...(name ? { identity: name } : {}) }, message);
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
    ...(name ? { identity: name } : {}),
    async token(scope, { forceRefresh, claims } = {}) {
      if (!scope.endsWith('/.default'))
        throw new Error(`App-only tokens need a /.default scope (got ${scope}).`);
      let result: { accessToken: string } | null;
      try {
        result = await getClient().acquireTokenByClientCredential({
          scopes: [scope],
          ...(forceRefresh || claims ? { skipCache: true } : {}),
          ...(claims ? { claims } : {}),
        });
      } catch (err) {
        if (err instanceof AppError) throw err;
        // MSAL errors carry AADSTS codes; keep only the first line (no trace ids, never the credential).
        const text =
          (err as { errorMessage?: string; message?: string })?.errorMessage ??
          (err as Error)?.message ??
          String(err);
        const first = text
          .split(/\r?\n/)[0]!
          .replace(/Trace ID:.*$/i, '')
          .trim();
        throw new AppError(
          502,
          'automation_token_failed',
          `${who} could not get a token for ${scope}: ${first}`,
          {
            hint: `Check ${keys}CLIENT_ID and its certificate/secret (adminforge provision status).`,
          },
        );
      }
      if (!result?.accessToken)
        throw new AppError(502, 'automation_token_failed', `${who} got no token for ${scope}.`);
      return result.accessToken;
    },
  };
}
