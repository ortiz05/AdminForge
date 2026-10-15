import { loadEnv } from '@adminforge/config';
import type { Config } from '../config';

/** Never exposed to expressions: credentials, keys, connection strings, test-only and bootstrap settings. */
const EXCLUDED = /SECRET|PASSWORD|TOKEN|WEBHOOK|_KEY$|CERT|TOTP|PRIVATE|^AF_TEST_|^AF_PROVISIONER_/i;
const CONFIG_KEYS = [
  'AF_TENANT_ID',
  'AF_PRIMARY_DOMAIN',
  'AF_SUBSCRIPTION_ID',
  'AF_SPO_TENANT_NAME',
  'AF_ENV_LABEL',
] as const;

/**
 * The `env` scope of content expressions (§7.6, R2): non-secret `AF_*` configuration such as the tenant id, primary
 * domain, default subscription, workspace ids or connection URLs declared in config/example.env. Rendered server-side
 * only; never sent to the browser. Tests (NODE_ENV=test) see only the validated config, never the local env file.
 */
export function contentEnv(config: Config, raw?: Record<string, string | undefined>): Record<string, string> {
  const source = raw ?? (config.NODE_ENV === 'test' ? {} : loadEnv());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source))
    if (/^AF_[A-Z0-9_]+$/.test(k) && v && v.trim() && !EXCLUDED.test(k)) out[k] = v.trim();
  for (const k of CONFIG_KEYS) {
    const v = config[k];
    if (v) out[k] = String(v);
  }
  return out;
}
