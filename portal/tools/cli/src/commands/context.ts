import { createGraphClient, createHttpClient, type GraphClient, type HttpClient, type Sleep } from '@adminforge/connectors';
import { clientCredentialToken } from '../provision/auth';
import { ENV_KEYS } from '../provision/entra-desired';
import { isGuid } from '../provision/ids';
import type { AppKey, ProvisionSettings } from '../provision/model';
import type { Out } from '../provision/render';
import type { RetryOptions } from '../provision/retry';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const ARM_SCOPE = 'https://management.azure.com/.default';

/** Everything a command needs from the outside world — injected so tests run without network or files. */
export interface CliContext {
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

export function provisionSettings(env: CliContext['env']): ProvisionSettings {
  const tenantId = env.AF_TENANT_ID;
  if (!isGuid(tenantId)) throw new ConfigError('AF_TENANT_ID is missing or not a GUID in the env file.');
  const label = env.AF_ENV_LABEL || 'dev';
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(label)) throw new ConfigError('AF_ENV_LABEL must be lowercase letters, digits, and dashes (max 20).');
  const baseUrl = (env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
  try {
    new URL(baseUrl);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL is not a valid URL.');
  }
  const subscriptionId = env.AF_SUBSCRIPTION_ID || undefined;
  if (subscriptionId && !isGuid(subscriptionId)) throw new ConfigError('AF_SUBSCRIPTION_ID is not a GUID.');
  return { label, baseUrl, tenantId, subscriptionId, primaryDomain: env.AF_PRIMARY_DOMAIN || undefined };
}

export interface Clients {
  graph: GraphClient;
  arm: HttpClient;
}

function clientsFor(ctx: CliContext, tenantId: string, clientId: string, clientSecret: string): Clients {
  const common = { fetch: ctx.fetch, sleep: ctx.sleep, timeoutMs: 60_000 };
  const token = (scope: string) => clientCredentialToken({ tenantId, clientId, clientSecret, scope, fetch: ctx.fetch });
  return {
    graph: createGraphClient({ ...common, getToken: token(GRAPH_SCOPE) }),
    arm: createHttpClient({ ...common, getToken: token(ARM_SCOPE), correlationHeader: 'x-ms-client-request-id', requestIdHeader: 'x-ms-request-id' }),
  };
}

/** Graph + ARM clients for the bootstrap provisioner identity. */
export function provisionerClients(ctx: CliContext, settings: ProvisionSettings): Clients {
  const id = ctx.env.AF_PROVISIONER_CLIENT_ID;
  const secret = ctx.env.AF_PROVISIONER_CLIENT_SECRET;
  if (!isGuid(id) || !secret) throw new ConfigError('AF_PROVISIONER_CLIENT_ID and AF_PROVISIONER_CLIENT_SECRET must be set in the env file.');
  return clientsFor(ctx, settings.tenantId, id, secret);
}

/** Clients for one of AdminForge's own apps (client credentials), when its id and secret are in the env file. */
export function appClients(ctx: CliContext, settings: ProvisionSettings, app: AppKey): Clients | undefined {
  const id = ctx.env[ENV_KEYS[app].clientId];
  const secret = ctx.env[ENV_KEYS[app].secret];
  return isGuid(id) && secret ? clientsFor(ctx, settings.tenantId, id, secret) : undefined;
}

/** The env keys the plans read (client ids/secrets, test identity). Values stay in memory only. */
export function envSubset(env: CliContext['env']): Record<string, string | undefined> {
  const keys = [...Object.values(ENV_KEYS).flatMap((k) => [k.clientId, k.secret]), 'AF_TEST_USER_UPN', 'AF_TEST_USER_PASSWORD'];
  return Object.fromEntries(keys.map((k) => [k, env[k] || undefined]));
}
