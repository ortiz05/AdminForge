/**
 * `adminforge audit verify [--env <name>]` — re-walks the tamper-evident audit log's hash chain in the database at
 * DATABASE_URL and reports whether every event still links to the one before it (the API's PgAuditWriter does the
 * walk; this command only prints the verdict). ADMINFORGE_ENV_OVERLAY=host checks the services' own database.
 *
 * Read-only: one connection, no writes, nothing in the tenant. Exit code 1 when the chain is broken.
 */
import { createDatabase, PgAuditWriter } from '../content/api-bridge';
import { ConfigError } from '../shared/errors';
import type { Out } from '../shared/output';

/** The audit chain a verify walks (injected in tests; default: the database at DATABASE_URL). */
export interface AuditChain {
  verify(): Promise<
    | { ok: true; count: number; tail?: { seq: number; hash: string } }
    | { ok: false; brokenAt: number; seq: number }
  >;
  close(): Promise<void>;
}

function openAuditChain(url: string): AuditChain {
  const database = createDatabase(url, { max: 1, name: 'cli' });
  // The verdict is printed here; the services' own verifications write the journal's checkpoint lines.
  const writer = new PgAuditWriter(database.db, undefined, null);
  return { verify: () => writer.verify(), close: () => database.close() };
}

/** Re-walks the hash chain. Returns true when every event links to the one before it. */
export async function auditVerify(
  env: Record<string, string | undefined>,
  out: Out,
  open: (url: string) => AuditChain = openAuditChain,
): Promise<boolean> {
  const url = env.DATABASE_URL;
  if (!url) throw new ConfigError('DATABASE_URL is not set in the env file.');
  const chain = open(url);
  try {
    const result = await chain.verify();
    if (result.ok) {
      out(`✓ Audit chain verified: ${result.count} event(s), every hash links to the one before it.`);
      // The external anchor: earlier "audit chain checkpoint" lines in the services' journal must agree with this chain.
      if (result.tail)
        out(
          `  Tail: seq ${result.tail.seq}, hash ${result.tail.hash}. Compare with the checkpoints the services logged (the audit-chain probe runs in the scheduler, the Audit page in the API): journalctl --user -u adminforge-scheduler -u adminforge-api | grep 'audit chain checkpoint'.`,
        );
      return true;
    }
    out(
      `✗ Audit chain broken at event #${result.brokenAt} (seq ${result.seq}): that row or one before it was changed or removed. Restore from a backup and investigate who had database write access.`,
    );
    return false;
  } finally {
    await chain.close();
  }
}
