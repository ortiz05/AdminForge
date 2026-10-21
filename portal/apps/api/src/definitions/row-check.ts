import { formatPath, schemaForKind, type ContentError, type Definition } from '@adminforge/schemas';
import { AppError } from '../errors';

/**
 * Load-time checks of published rows (S-07): `publish` validated a body before writing it, but the database file can
 * also be written by `db import-postgres`, a restored copy or anything else with the volume, and a schema may have
 * changed since (D-07). So a stored body is parsed with its kind's current schema and must name its own row's kind,
 * id and version before the API uses it. The sha256 is of the YAML source, so it can't be recomputed from the body.
 */

/** The columns a stored body must agree with. */
export interface RowIdentity {
  kind: string;
  key: string;
  version: string;
}

/** At most this many schema problems are kept per row (the log line and `publish --dry-run`). */
const MAX_PROBLEMS = 5;

/** The parsed definition, or why the body can't be used (`path: message` lines). */
export function checkStoredBody(
  row: RowIdentity,
  body: unknown,
): { ok: true; def: Definition } | { ok: false; problems: string[] } {
  const schema = schemaForKind(row.kind);
  if (!schema) return { ok: false, problems: [`"${row.kind}" is not a content kind`] };
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, MAX_PROBLEMS).map((i) => {
        const at = formatPath(i.path.filter((p) => typeof p !== 'symbol'));
        return at ? `${at}: ${i.message}` : i.message;
      }),
    };
  const def = parsed.data as Definition;
  const problems: string[] = [];
  if (def.kind !== row.kind) problems.push(`kind is ${def.kind}, not ${row.kind}`);
  if (def.id !== row.key) problems.push(`id is ${def.id}, not ${row.key}`);
  if (def.version !== row.version) problems.push(`version is ${def.version}, not ${row.version}`);
  return problems.length ? { ok: false, problems } : { ok: true, def };
}

/** How a refused row appears in `problems()` (the content health check). */
export const rowProblem = (row: RowIdentity, problems: string[]): ContentError => ({
  file: `${row.kind}:${row.key}@${row.version} (published)`,
  path: '',
  message: `The published copy doesn't pass the content schema, so the API refuses it: ${problems.join('; ')}. Publish the content again from git.`,
});

/** 500 `definition_unavailable`: a published row failed the load-time check. The detail is in the API log only. */
export const definitionUnavailable = (row: RowIdentity) =>
  new AppError(
    500,
    'definition_unavailable',
    `The published ${row.kind} "${row.key}" (version ${row.version}) doesn't pass AdminForge's content checks, so it isn't used.`,
    {
      hint: 'Ask a Portal Admin to publish the content again from git; the API log names what failed (quote the reference).',
    },
  );
