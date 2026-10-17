/**
 * Provisioning settings from the env file: turns raw configuration values into a validated `ProvisionSettings` for
 * one environment, or throws `ConfigError` naming the key to fix (never its value).
 *
 * Reads: AF_TENANT_ID, AF_ENV_LABEL, PUBLIC_BASE_URL, AF_REDIRECT_BASE_URLS, AF_SUBSCRIPTION_ID, AF_PRIMARY_DOMAIN,
 * AF_AUTOMATION_CERT_PATH (the certificate file), AF_TEST_IDENTITY_LABELS and the permission-ceiling opt-ins
 * (AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS, AF_ALLOW_PRIVILEGED_WRITE_SCOPES, AF_AUTOMATION_ALLOW_SENSITIVE_READS,
 * AF_MAIL_SENDER). Rules it enforces:
 *   - redirect origins are https, or http on loopback only (an http redirect URI on a LAN or public host would carry
 *     authorization codes in clear text) — also used by `env check` (env/env-check.ts);
 *   - ceilings are lifted only by the exact value "true" (provision/privilege.ts, SECURITY.md → Identities);
 *   - test identities only in environments listed in AF_TEST_IDENTITY_LABELS (default dev,test).
 *
 * Pure apart from reading the certificate file; used by commands/provision.ts, commands/azure-test.ts,
 * commands/validate.ts (`--scopes`) and provision/clients.ts.
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from '../shared/errors';
import { CertificateError, parseCertificatePem, type LoadedCertificate } from './certificate';
import { ENV_KEYS, type CeilingSettings } from './entra-desired';
import { isGuid } from './ids';
import type { ProvisionSettings } from './model';

/** Configuration values (env file overlaid by process env). Never printed. */
export type Env = Record<string, string | undefined>;

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
export const ceilingSettings = (env: Env): CeilingSettings => ({
  allowAutomationWrites: env.AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS === 'true',
  allowPrivilegedWriteScopes: env.AF_ALLOW_PRIVILEGED_WRITE_SCOPES === 'true',
  allowAutomationSensitiveReads: env.AF_AUTOMATION_ALLOW_SENSITIVE_READS === 'true',
  emailDelivery: Boolean(env.AF_MAIL_SENDER?.trim()),
  // Unset or blank = every Query Studio source, the API's default (apps/api/src/config.ts).
  advancedHunting:
    !env.AF_QUERY_SOURCES?.trim() ||
    env.AF_QUERY_SOURCES.split(',').some((s) => s.trim() === 'advancedHunting'),
});

/** Environment labels that may hold the validation user and AF-Test-* objects (AF_TEST_IDENTITY_LABELS). */
export const testIdentityLabels = (env: Env) =>
  (env.AF_TEST_IDENTITY_LABELS || 'dev,test')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/** Reads AF_AUTOMATION_CERT_PATH (certificate, optionally with its private key). Undefined when not configured. */
export function automationCertificate(
  env: Env,
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

/** The validated settings for this environment; throws ConfigError naming the key to fix. */
export function provisionSettings(env: Env): ProvisionSettings {
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

/** The env keys the plans read (client ids/secrets, test identity). Values stay in memory only. */
export function envSubset(env: Env): Record<string, string | undefined> {
  const keys = [
    ...Object.values(ENV_KEYS).flatMap((k) => [k.clientId, k.secret]),
    'AF_PROVISIONER_CLIENT_ID',
    'AF_TEST_USER_UPN',
    'AF_TEST_USER_PASSWORD',
  ];
  return Object.fromEntries(keys.map((k) => [k, env[k] || undefined]));
}
