/**
 * Errors the CLI turns into one readable line instead of a stack trace.
 *
 * - `ConfigError`: a problem the person running the CLI fixes in the env file or on the command line (a missing key,
 *   an unknown option value). Every command throws it for setup problems; `index.ts` prints `✗ <message>` and exits 1.
 * - `describeFailure`: the one-line summary for anything else that reaches `index.ts` (database down, DNS failure,
 *   wrong Postgres password), with the usual fix. The stack trace is printed only with ADMINFORGE_DEBUG=1.
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

/** How deep `cause` chains are followed (Drizzle wraps the pg error; guard against cycles). */
const MAX_CAUSE_DEPTH = 5;

/**
 * One line for an unexpected failure, with the usual fix. Drivers wrap the real failure (Drizzle: "Failed query: …"
 * with the pg error as `cause`), so the root cause decides the message.
 */
export function describeFailure(err: unknown): string {
  let root = err as { cause?: unknown } | undefined;
  for (let i = 0; i < MAX_CAUSE_DEPTH && root?.cause; i++) root = root.cause as { cause?: unknown };
  const e = root as { code?: string; message?: string; address?: string; port?: number } | undefined;
  const where = e?.address ? `${e.address}${e.port ? `:${e.port}` : ''}` : 'the configured host';
  if (e?.code === 'ECONNREFUSED')
    return `Can't connect to ${where}. If that's Postgres, start it with \`pnpm db:up\` (and check DATABASE_URL).`;
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN')
    return `Can't resolve a host name (${e.message ?? 'DNS lookup failed'}). Check your network or proxy.`;
  if (e?.code === '28P01') return 'Postgres rejected the password in DATABASE_URL.';
  if (e?.code === '3D000')
    return "The database in DATABASE_URL doesn't exist. Run `pnpm --filter @adminforge/api db:migrate`.";
  const message = (e?.message ?? String(err)).split('\n')[0]!.slice(0, MAX_MESSAGE);
  return `${message} (run with ADMINFORGE_DEBUG=1 for details)`;
}
