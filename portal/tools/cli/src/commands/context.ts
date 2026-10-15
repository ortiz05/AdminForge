import {
  createGraphClient,
  createHttpClient,
  type GraphClient,
  type HttpClient,
  type Sleep,
} from '@adminforge/connectors';
import { readFileSync } from 'node:fs';
import type { TokenProvider } from '@adminforge/connectors';
import { clientCredentialToken } from '../provision/auth';
import {
  CertificateError,
  clientAssertion,
  parseCertificatePem,
  type LoadedCertificate,
} from '../provision/certificate';
import { ENV_KEYS, type CeilingSettings } from '../provision/entra-desired';
import { isGuid } from '../provision/ids';
import type { AppKey, ProvisionSettings } from '../provision/model';
import type { Out } from '../provision/render';
import type { RetryOptions } from '../provision/retry';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const ARM_SCOPE = 'https://management.azure.com/.default';

/** Everything a command needs from the outside world — injected so tests run without network or files. */
export interface CliContext {
  /** Content-declared scopes (tests inject; default: loaded from portal/content). */
  contentScopes?: import('../provision/entra-desired').ContentScopes;
  /** Tests: files declaring each permission (`app:service:scope`), with contentScopes. */
  contentFiles?: Map<string, string[]>;
  /** Configuration values (env file overlaid by process env). Never printed. */
  env: Record<string, string | undefined>;
  /** Upserts keys in the local env file. */
  writeEnv: (updates: Record<string, string>) => void;
  out: Out;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => Date;
  retry?: RetryOptions;
}

/** A configuration problem the user fixes in the env file (printed without a stack trace). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Problem with an origin used for Entra redirect URIs, or undefined when it is fine: https, or http only on loopback
 * (an http redirect URI on a LAN or public host would carry authorization codes in clear text).
 */
export function originProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:')
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? undefined
      : 'must use https (http is accepted only for localhost, 127.0.0.1 and ::1)';
  return 'must be an http(s) URL';
}

/** The opt-ins that lift provisioning's permission ceilings (provision/privilege.ts). Off unless exactly "true". */
export const ceilingSettings = (env: CliContext['env']): CeilingSettings => ({
  allowAutomationWrites: env.AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS === 'true',
  allowPrivilegedWriteScopes: env.AF_ALLOW_PRIVILEGED_WRITE_SCOPES === 'true',
  allowAutomationSensitiveReads: env.AF_AUTOMATION_ALLOW_SENSITIVE_READS === 'true',
  emailDelivery: Boolean(env.AF_MAIL_SENDER?.trim()),
});

/** Environment labels that may hold the validation user and AF-Test-* objects (AF_TEST_IDENTITY_LABELS). */
export const testIdentityLabels = (env: CliContext['env']) =>
  (env.AF_TEST_IDENTITY_LABELS || 'dev,test')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/** Reads AF_AUTOMATION_CERT_PATH (certificate, optionally with its private key). Undefined when not configured. */
export function automationCertificate(
  env: CliContext['env'],
  opts: { requireKey?: boolean } = {},
): LoadedCertificate | undefined {
  const file = env.AF_AUTOMATION_CERT_PATH;
  if (!file) return undefined;
  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError('AF_AUTOMATION_CERT_PATH is set but the file cannot be read.');
  }
  try {
    return parseCertificatePem(pem, opts);
  } catch (err) {
    if (err instanceof CertificateError) throw new ConfigError(err.message);
    throw err;
  }
}

export function provisionSettings(env: CliContext['env']): ProvisionSettings {
  const tenantId = env.AF_TENANT_ID;
  if (!isGuid(tenantId)) throw new ConfigError('AF_TENANT_ID is missing or not a GUID in the env file.');
  const label = env.AF_ENV_LABEL || 'dev';
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(label))
    throw new ConfigError('AF_ENV_LABEL must be lowercase letters, digits, and dashes (max 20).');
  const baseUrl = (env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const baseProblem = originProblem(baseUrl);
  if (baseProblem) throw new ConfigError(`PUBLIC_BASE_URL ${baseProblem}.`);
  const subscriptionId = env.AF_SUBSCRIPTION_ID || undefined;
  if (subscriptionId && !isGuid(subscriptionId)) throw new ConfigError('AF_SUBSCRIPTION_ID is not a GUID.');
  const extraBaseUrls = (env.AF_REDIRECT_BASE_URLS ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const u of extraBaseUrls) {
    const problem = originProblem(u);
    if (problem)
      throw new ConfigError(
        `AF_REDIRECT_BASE_URLS must be a comma-separated list of URLs; one of them ${problem}.`,
      );
  }
  const certificate = automationCertificate(env);
  return {
    label,
    baseUrl,
    extraBaseUrls,
    tenantId,
    subscriptionId,
    primaryDomain: env.AF_PRIMARY_DOMAIN || undefined,
    ...ceilingSettings(env),
    ...(certificate ? { automationCertificate: certificate.info } : {}),
    testIdentitiesAllowed: testIdentityLabels(env).includes(label),
  };
}

export interface Clients {
  graph: GraphClient;
  arm: HttpClient;
}

type Credential = { clientSecret: string } | { clientAssertion: (tokenEndpoint: string) => string };

function clientsFor(ctx: CliContext, tenantId: string, clientId: string, credential: Credential): Clients {
  const common = { fetch: ctx.fetch, sleep: ctx.sleep, timeoutMs: 60_000 };
  const token = (scope: string) =>
    clientCredentialToken({ tenantId, clientId, ...credential, scope, fetch: ctx.fetch });
  return {
    graph: createGraphClient({ ...common, getToken: token(GRAPH_SCOPE) }),
    arm: createHttpClient({
      ...common,
      getToken: token(ARM_SCOPE),
      correlationHeader: 'x-ms-client-request-id',
      requestIdHeader: 'x-ms-request-id',
    }),
  };
}

/** Graph + ARM clients for the bootstrap provisioner identity. */
export function provisionerClients(ctx: CliContext, settings: ProvisionSettings): Clients {
  const id = ctx.env.AF_PROVISIONER_CLIENT_ID;
  const secret = ctx.env.AF_PROVISIONER_CLIENT_SECRET;
  if (!isGuid(id) || !secret)
    throw new ConfigError(
      'AF_PROVISIONER_CLIENT_ID and AF_PROVISIONER_CLIENT_SECRET must be set in the env file.',
    );
  return clientsFor(ctx, settings.tenantId, id, { clientSecret: secret });
}

/**
 * How one of AdminForge's own apps authenticates from this machine: the automation identity uses the certificate in
 * AF_AUTOMATION_CERT_PATH when set (like the API), otherwise each app uses its client secret from the env file.
 */
export function appCredential(
  ctx: Pick<CliContext, 'env'>,
  app: AppKey,
): { clientId: string; credential: Credential; kind: 'certificate' | 'secret' } | undefined {
  const id = ctx.env[ENV_KEYS[app].clientId];
  if (!isGuid(id)) return undefined;
  if (app === 'automation') {
    const cert = automationCertificate(ctx.env, { requireKey: true });
    if (cert)
      return {
        clientId: id,
        kind: 'certificate',
        credential: { clientAssertion: (aud) => clientAssertion(cert, { clientId: id, tokenEndpoint: aud }) },
      };
  }
  const secret = ctx.env[ENV_KEYS[app].secret];
  return secret ? { clientId: id, kind: 'secret', credential: { clientSecret: secret } } : undefined;
}

/** Token provider for one of AdminForge's own apps (see appCredential), or undefined when it has no credential here. */
export function appToken(
  ctx: Pick<CliContext, 'env' | 'fetch'>,
  tenantId: string,
  app: AppKey,
  scope: string,
): TokenProvider | undefined {
  const c = appCredential(ctx, app);
  return c
    ? clientCredentialToken({ tenantId, clientId: c.clientId, ...c.credential, scope, fetch: ctx.fetch })
    : undefined;
}

/** Clients for one of AdminForge's own apps (client credentials), when its credential is available here. */
export function appClients(ctx: CliContext, settings: ProvisionSettings, app: AppKey): Clients | undefined {
  const c = appCredential(ctx, app);
  return c ? clientsFor(ctx, settings.tenantId, c.clientId, c.credential) : undefined;
}

/** The env keys the plans read (client ids/secrets, test identity). Values stay in memory only. */
export function envSubset(env: CliContext['env']): Record<string, string | undefined> {
  const keys = [
    ...Object.values(ENV_KEYS).flatMap((k) => [k.clientId, k.secret]),
    'AF_PROVISIONER_CLIENT_ID',
    'AF_TEST_USER_UPN',
    'AF_TEST_USER_PASSWORD',
  ];
  return Object.fromEntries(keys.map((k) => [k, env[k] || undefined]));
}
