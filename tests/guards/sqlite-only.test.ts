import { committableFiles, readText } from '../lib/repo';

// The database is one SQLite file (ADR-016). Postgres is gone from the runtime: no driver, no job queue on it, no
// SQL only Postgres understands — and transactions are synchronous (better-sqlite3 runs a transaction function to
// completion; an `async` one would commit before its awaits ran). The one exception is the one-time importer.
const runtime = committableFiles()
  .filter((f) => /^portal\/(apps|packages|tools)\/.+\.tsx?$/.test(f) && !f.includes('/node_modules/'))
  .map((f) => [f, readText(f) ?? ''] as const);
const IMPORTER = 'portal/tools/cli/src/commands/db.ts';

const RULES: Array<[string, RegExp]> = [
  ['an async transaction function', /\.transaction\(\s*async\b/],
  ['drizzle ilike (SQLite has no ILIKE: use LIKE … ESCAPE)', /\bilike\(/],
  ['selectDistinctOn (Postgres DISTINCT ON)', /\bselectDistinctOn\b/],
  ["SELECT … FOR UPDATE (writeTx's BEGIN IMMEDIATE serialises writers)", /\.for\(\s*['"]update['"]\s*\)/],
  ['Postgres casts', /::(jsonb|json|text\[\]|uuid|timestamptz|int)\b/],
  ['LISTEN/NOTIFY or advisory locks', /\bpg_(notify|try_advisory_lock|advisory_xact_lock|advisory_lock)\b/],
  ['drizzle pg-core or node-postgres', /drizzle-orm\/(pg-core|node-postgres)/],
  // REPLACE deletes the old row: on audit_events or approvals that is history rewritten (the triggers refuse it).
  [
    'INSERT OR REPLACE / REPLACE INTO (use ON CONFLICT … DO UPDATE)',
    /\binsert\s+or\s+replace\s+into\b|[`'"]\s*replace\s+into\b/i,
  ],
];

describe('runtime code is SQLite-only', () => {
  it.each(RULES)('no %s', (_label, pattern) => {
    expect(runtime.filter(([f, t]) => f !== IMPORTER && pattern.test(t)).map(([f]) => f)).toEqual([]);
  });

  it('imports neither pg nor pg-boss (the importer alone reads Postgres, once)', () => {
    const hits = runtime
      .filter(([f, t]) => /from ['"](pg|pg-boss)['"]/.test(t) && f !== IMPORTER)
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it('no runtime package depends on pg or pg-boss', () => {
    const manifests = committableFiles().filter((f) => /^portal\/.+\/package\.json$/.test(f));
    const hits = manifests.filter((f) => {
      const pkg = JSON.parse(readText(f) ?? '{}') as { dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {});
      return deps.includes('pg-boss') || (deps.includes('pg') && f !== 'portal/tools/cli/package.json');
    });
    expect(hits).toEqual([]);
  });
});
