/**
 * Microsoft Graph and Azure Resource Manager clients for the provisioning commands, and the context those commands
 * run in.
 *
 * Two kinds of identity sign in from this machine with client credentials (app-only, never a user):
 *   - the bootstrap **provisioner** (AF_PROVISIONER_CLIENT_ID / _SECRET in <env>.admin.env) — creates and reads the
 *     AdminForge apps, groups, grants and Azure role assignments (`provisionerClients`);
 *   - AdminForge's **own apps** (Read, Write, Automation) — only for `provision status` token checks and the
 *     Log Analytics query check; the automation identity uses its certificate (AF_AUTOMATION_CERT_PATH) when set, like
 *     the API does, otherwise each app uses its client secret from the env file (`appCredential`, `appClients`).
 * Tokens stay inside the token providers (provision/auth.ts); nothing here prints or logs them.
 *
 * `CliContext` is everything a provisioning command needs from the outside world (env, env-file writer, output,
 * fetch, sleep, clock, retry timing, content scopes). `index.ts` builds the real one; tests inject fakes, so the
 * commands run without network or files.
 */
import {
  createGraphClient,
  createHttpClient,
  type GraphClient,
  type HttpClient,
  type Sleep,
  type TokenProvider,
} from '@adminforge/connectors';
import type { Out } from '../shared/output';
import { ConfigError } from '../shared/errors';
import { clientCredentialToken } from './auth';
import { clientAssertion } from './certificate';
import { ENV_KEYS, type ContentScopes } from './entra-desired';
import { isGuid } from './ids';
import type { AppKey, ProvisionSettings } from './model';
import type { RetryOptions } from './retry';
import { automationCertificate, type Env } from './settings';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const ARM_SCOPE = 'https://management.azure.com/.default';

/** Everything a provisioning command needs from the outside world — injected so tests run without network or files. */
export interface CliContext {
  /** Content-declared scopes (tests inject; default: loaded from portal/content). */
  contentScopes?: ContentScopes;
  /** Tests: files declaring each permission (`app:service:scope`), with contentScopes. */
  contentFiles?: Map<string, string[]>;
  /** Configuration values (env file overlaid by process env). Never printed. */
  env: Env;
  /** Upserts keys in the local env file. */
  writeEnv: (updates: Record<string, string>) => void;
  out: Out;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => Date;
  retry?: RetryOptions;
}

/** A Graph client and an ARM client signed in as the same identity. */
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
