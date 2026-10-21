import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '@adminforge/config';
import type { Config } from '../config';
import { workspaceRoot } from '../paths';

/** Never exposed to expressions: credentials, keys, connection strings, test-only and bootstrap settings. */
const EXCLUDED = /SECRET|PASSWORD|TOKEN|WEBHOOK|_KEY$|CERT|TOTP|PRIVATE|^AF_TEST_|^AF_PROVISIONER_/i;

/** Whether `${ env.<key> }` can never reach content (`adminforge validate` refuses content that names such a key). */
export const hiddenFromContent = (key: string): boolean => EXCLUDED.test(key);
const CONFIG_KEYS = [
  'AF_TENANT_ID',
  'AF_PRIMARY_DOMAIN',
  'AF_SUBSCRIPTION_ID',
  'AF_SPO_TENANT_NAME',
  'AF_ENV_LABEL',
] as const;

/**
 * The keys config/example.env declares: `KEY=` at the start of a line (comments and prose are not declarations),
 * read the way `adminforge validate` reads them for content's `env.X` references.
 */
export function declaredEnvKeys(exampleText: string): string[] {
  return exampleText.match(/^[A-Z0-9_]+(?==)/gm) ?? [];
}

/** config/example.env of this checkout or image (the image copies it next to the bundles). */
export const exampleEnvFile = (): string => path.join(workspaceRoot(), 'config', 'example.env');

/**
 * The settings content may read: the `AF_*` keys config/example.env declares, minus secret-looking names — an
 * allow-list (S-29). Anything else set in the environment (in the pod, the whole Secret and ConfigMap) never reaches
 * content, whatever its name. Without the example file nothing would be known to be safe, so this throws (at start-up).
 */
export function contentEnvKeys(file: string = exampleEnvFile()): ReadonlySet<string> {
  if (!existsSync(file))
    throw new Error(
      `config/example.env was not found at ${file}: content may read only the settings it declares, so it must ship with AdminForge.`,
    );
  return new Set(
    declaredEnvKeys(readFileSync(file, 'utf8')).filter(
      (k) => /^AF_[A-Z0-9_]+$/.test(k) && !hiddenFromContent(k),
    ),
  );
}

/**
 * The `env` scope of content expressions (§7.6, R2): non-secret `AF_*` configuration declared in config/example.env,
 * such as the tenant id, primary domain, default subscription, workspace ids or connection URLs (`contentEnvKeys`).
 * Rendered server-side only; never sent to the browser. Tests (NODE_ENV=test) see only the validated config, never
 * the local env file.
 */
export function contentEnv(
  config: Config,
  raw?: Record<string, string | undefined>,
  allowed: ReadonlySet<string> = contentEnvKeys(),
): Record<string, string> {
  const source = raw ?? (config.NODE_ENV === 'test' ? {} : loadEnv());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (allowed.has(k) && v && v.trim()) out[k] = v.trim();
  for (const k of CONFIG_KEYS) {
    const v = config[k];
    if (v) out[k] = String(v);
  }
  return out;
}
