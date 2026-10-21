/**
 * Errors the CLI turns into one readable line instead of a stack trace.
 *
 * - `ConfigError`: a problem the person running the CLI fixes in the env file or on the command line (a missing key,
 *   an unknown option value). Every command throws it for setup problems; `index.ts` prints `✗ <message>` and exits 1.
 * - `describeFailure`: the one-line summary for anything else that reaches `index.ts` (database down, DNS failure,
 *   a busy database file, a wrong Postgres password for the importer), with the usual fix. The stack trace is printed only with ADMINFORGE_DEBUG=1.
 *
 * Messages may name env keys and CLI commands — the CLI is administrator tooling (CLAUDE.md rule 10) — but never
 * values from the env file. This module imports nothing from the rest of the CLI, so every layer can use it.
 */

/** A configuration problem the user fixes in the env file (printed without a stack trace). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Unexpected failure text is cut at this many characters (driver messages can carry whole SQL statements). */
const MAX_MESSAGE = 300;

/** How deep `cause` chains are followed (Drizzle wraps the driver's error; guard against cycles). */
const MAX_CAUSE_DEPTH = 5;

/**
 * One line for an unexpected failure, with the usual fix. Drivers wrap the real failure (Drizzle: "Failed query: …"
 * with the SQLite error as `cause`), so the root cause decides the message.
 */
export function describeFailure(err: unknown): string {
  let root = err as { cause?: unknown } | undefined;
  for (let i = 0; i < MAX_CAUSE_DEPTH && root?.cause; i++) root = root.cause as { cause?: unknown };
  const e = root as { code?: string; message?: string; address?: string; port?: number } | undefined;
  const where = e?.address ? `${e.address}${e.port ? `:${e.port}` : ''}` : 'the configured host';
  if (e?.code === 'ECONNREFUSED')
    return `Can't connect to ${where}. Check that it is running and the address is right.`;
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN')
    return `Can't resolve a host name (${e.message ?? 'DNS lookup failed'}). Check your network or proxy.`;
  // The SQLite database (DATABASE_PATH).
  if (e?.code === 'SQLITE_CANTOPEN')
    return "Can't open the database file in DATABASE_PATH. Check the path, and that its folder exists and is yours.";
  if (e?.code === 'SQLITE_BUSY')
    return 'The database is busy (another process is writing). Try again in a moment.';
  if (e?.code === 'SQLITE_READONLY')
    return 'The database file in DATABASE_PATH is read-only for you. Run the command as the account that owns it.';
  if (e?.code === 'SQLITE_NOTADB' || e?.code === 'SQLITE_CORRUPT')
    return 'The file in DATABASE_PATH is not a usable AdminForge database. Restore it from a backup (docs/operations.md → Backups).';
  if (typeof e?.message === 'string' && /^no such table/.test(e.message))
    return 'The database has no AdminForge tables yet. Run `pnpm --filter @adminforge/api db:migrate` (the API does it at start).';
  // The Postgres database `db import-postgres` reads from.
  if (e?.code === '28P01')
    return 'Postgres rejected the password in the URL of the database to import (DATABASE_URL, or --from-env).';
  if (e?.code === '3D000')
    return "The Postgres database to import (DATABASE_URL, or --from-env) doesn't exist.";
  const message = (e?.message ?? String(err)).split('\n')[0]!.slice(0, MAX_MESSAGE);
  return `${message} (run with ADMINFORGE_DEBUG=1 for details)`;
}
