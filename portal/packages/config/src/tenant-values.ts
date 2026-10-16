/**
 * Which local configuration values count as tenant data — the one rule behind CLAUDE.md non-negotiable 1 ("nothing
 * tenant-specific in git"), shared by:
 *   - the no-tenant-data guard (tests/guards/no-tenant-data.test.ts, also the pre-commit hook): no committable file may
 *     contain a value from a local env file;
 *   - `adminforge fixtures record` (portal/tools/cli/src/commands/fixtures.ts): a sanitized fixture that still
 *     contains such a value is refused.
 *
 * A value counts when it is at least 8 characters and not an obviously generic one (true/false, a number, a bare
 * loopback origin, a postgres URL on 127.0.0.1); values of *DOMAIN* keys also count lower-cased. Microsoft-published
 * licence SKU part numbers under AF_LICENCE_SKU_<n> are exempt — they are the same in every tenant and appear in
 * committed content — but only when the value looks like a part number.
 *
 * Dependency-free (no node: imports) so guards, hooks and the CLI can load it without pulling in anything else.
 */

/** Configuration keys whose values are public Microsoft catalogue names, not tenant data. */
export const PUBLIC_CATALOGUE_KEY = /^AF_LICENCE_SKU_\d+$/;

/** What a SKU part number looks like (ENTERPRISEPREMIUM, SPE_E5). Anything else — even a real one — is tenant data. */
export const SKU_PART_NUMBER = /^[A-Z0-9_]{2,64}$/;

/**
 * Keys that hold AdminForge configuration which can be tenant data, for sources that also carry the process
 * environment (PATH, HOME, …) — what `loadEnv` returns. Env files hold configuration only, so the guard checks every
 * key in them.
 */
export const TENANT_CONFIG_KEY =
  /^(AF_|DATABASE_URL|POSTGRES_|TOKEN_CACHE_KEY|RUNNER_|ANTHROPIC_|PUBLIC_BASE_URL)/;

/**
 * Values too generic to identify a tenant: booleans, numbers, a bare loopback origin (RUNNER_URL=http://127.0.0.1:3101,
 * the config/example.env default — anything with a path still counts), a postgres URL on 127.0.0.1.
 */
const GENERIC_VALUE =
  /^(true|false|\d+|https?:\/\/localhost(:\d+)?\/?|https?:\/\/127\.0\.0\.1(:\d+)?\/?|postgres:\/\/.*@127\.0\.0\.1.*)$/i;

/** Shorter values are too likely to occur by chance in unrelated text. */
const MIN_LENGTH = 8;

/**
 * A configuration value that is a public Microsoft catalogue name: an AF_LICENCE_SKU_<n> key whose value looks like a
 * SKU part number. Anything else under such a key (a domain, an id, a tenant's own name) is still tenant data.
 */
export const isPublicCatalogueValue = (key: string, value: string) =>
  PUBLIC_CATALOGUE_KEY.test(key) && SKU_PART_NUMBER.test(value);

export interface TenantValuesOptions {
  /**
   * The entries also carry the process environment (as `loadEnv` returns them): only upper-case AdminForge
   * configuration keys (TENANT_CONFIG_KEY) count. Leave off for the entries of an env file.
   */
  configKeysOnly?: boolean;
}

/** Values from `entries` that must not appear in committable files or fixtures (deduplicated). */
export function tenantValues(
  entries: Readonly<Record<string, string | undefined>>,
  opts: TenantValuesOptions = {},
): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    if (opts.configKeysOnly && !(/^[A-Z][A-Z0-9_]*$/.test(key) && TENANT_CONFIG_KEY.test(key))) continue;
    if (isPublicCatalogueValue(key, value)) continue;
    if (value.length >= MIN_LENGTH && !GENERIC_VALUE.test(value)) values.add(value);
    if (/DOMAIN/.test(key)) values.add(value.toLowerCase());
  }
  return [...values];
}
