/**
 * `adminforge audit verify [--env <name>]` — re-walks the tamper-evident audit log's hash chain in the database file
 * at DATABASE_PATH and reports whether every event still links to the one before it (the API's SqliteAuditWriter does
 * the walk; this command only prints the verdict). In the pod: `kubectl exec deploy/adminforge -c api -- adminforge
 * audit verify`.
 *
 * Read-only: opens the file read-only, writes nothing, nothing in the tenant. Exit code 1 when the chain is broken.
 */
import { createDatabase, SqliteAuditWriter } from '../content/api-bridge';
import { databasePath } from '../shared/database-path';
import type { Out } from '../shared/output';

/** The audit chain a verify walks (injected in tests; default: the database file at DATABASE_PATH). */
export interface AuditChain {
  verify(): Promise<
    | { ok: true; count: number; tail?: { seq: number; hash: string } }
    | { ok: false; brokenAt: number; seq: number }
  >;
  close(): Promise<void>;
}

function openAuditChain(file: string): AuditChain {
  const database = createDatabase(file, { readonly: true, name: 'cli' });
  // The verdict is printed here; the API's own verifications write the checkpoint lines to its log.
  const writer = new SqliteAuditWriter(database.db, undefined, null);
  return { verify: () => writer.verify(), close: () => database.close() };
}

/** Re-walks the hash chain. Returns true when every event links to the one before it. */
export async function auditVerify(
  env: Record<string, string | undefined>,
  out: Out,
  open: (file: string) => AuditChain = openAuditChain,
): Promise<boolean> {
  const chain = open(databasePath(env));
  try {
    const result = await chain.verify();
    if (result.ok) {
      out(`✓ Audit chain verified: ${result.count} event(s), every hash links to the one before it.`);
      // The external anchor: earlier "audit chain checkpoint" lines in the API's log must agree with this chain.
      if (result.tail)
        out(
          `  Tail: seq ${result.tail.seq}, hash ${result.tail.hash}. Compare with the checkpoints the API logged (the audit-chain probe and the Audit page write them): your log store's copy of the api container's log, or kubectl logs deploy/adminforge -c api | grep 'audit chain checkpoint'.`,
        );
      return true;
    }
    out(
      `✗ Audit chain broken at event #${result.brokenAt} (seq ${result.seq}): that row or one before it was changed or removed. Restore from a backup and investigate who had write access to the volume.`,
    );
    return false;
  } finally {
    await chain.close();
  }
}
