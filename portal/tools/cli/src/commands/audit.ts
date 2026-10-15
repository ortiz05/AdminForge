import { createDatabase, PgAuditWriter } from '../content/api-bridge';
import { ConfigError } from './context';
import type { Out } from '../provision/render';

/**
 * `adminforge audit verify` — re-walks the hash chain of the database in DATABASE_URL (use ADMINFORGE_ENV_OVERLAY=host
 * for the services' database). Returns true when every event links to the one before it.
 */
export async function auditVerify(env: Record<string, string | undefined>, out: Out): Promise<boolean> {
  const url = env.DATABASE_URL;
  if (!url) throw new ConfigError('DATABASE_URL is not set in the env file.');
  const database = createDatabase(url, { max: 1 });
  try {
    const result = await new PgAuditWriter(database.db).verify();
    if (result.ok) {
      out(`✓ Audit chain verified: ${result.count} event(s), every hash links to the one before it.`);
      return true;
    }
    out(
      `✗ Audit chain broken at event #${result.brokenAt} (seq ${result.seq}): that row or one before it was changed or removed. Restore from a backup and investigate who had database write access.`,
    );
    return false;
  } finally {
    await database.close();
  }
}
