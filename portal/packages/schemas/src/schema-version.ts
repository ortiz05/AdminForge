/**
 * The content schema version: one integer for every kind of definition. `adminforge publish` stamps it on each row it
 * writes (`definitions.schema_version`), the API re-validates every row against the current schemas when it loads it,
 * and `adminforge publish --dry-run` lists the rows published under an older version.
 *
 * Bump it — in the same change, and say so in CHANGELOG.md — when a schema change is **not backward-compatible**: when
 * a definition that validated before may no longer validate (a field removed, renamed, narrowed or made required, an
 * enum value dropped, a default that changes meaning). Additive, optional changes keep the number. After an upgrade
 * that bumps it, publish the content again (`adminforge publish`); rows that still fail are refused, never run.
 * Rule recorded in docs/decisions.md (Content and monitoring).
 *
 * 1 — rows published before the version existed.
 * 2 — param and input `pattern:`s refused when they can backtrack without bound; `status` columns need tones and
 *     plain categories are `enum` columns (platform review, 2026-10-21).
 */
export const CONTENT_SCHEMA_VERSION = 2;
