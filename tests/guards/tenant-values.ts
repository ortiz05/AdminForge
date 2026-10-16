// Which local configuration values count as tenant data for the guards (same rule as forbiddenValues in
// portal/tools/cli/src/commands/content.ts, kept free of portal imports).

/** An AF_LICENCE_SKU_<n> value that looks like a SKU part number: public Microsoft catalogue name, not tenant data. */
export const isPublicCatalogueValue = (key: string, value: string) =>
  /^AF_LICENCE_SKU_\d+$/.test(key) && /^[A-Z0-9_]{2,64}$/.test(value);

/** Values from one env file that must not appear in committable files. */
export function tenantValues(entries: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(entries)) {
    // Microsoft-published SKU part numbers are the same in every tenant — only when the value looks like one.
    if (isPublicCatalogueValue(key, value)) continue;
    // A bare loopback origin (RUNNER_URL=http://127.0.0.1:3101, the config/example.env default) isn't tenant data;
    // anything with a path still counts.
    if (
      value.length >= 8 &&
      !/^(true|false|\d+|https?:\/\/localhost(:\d+)?\/?|https?:\/\/127\.0\.0\.1(:\d+)?\/?|postgres:\/\/.*@127\.0\.0\.1.*)$/i.test(
        value,
      )
    )
      values.add(value);
    if (/DOMAIN/.test(key)) values.add(value.toLowerCase());
  }
  return [...values];
}
