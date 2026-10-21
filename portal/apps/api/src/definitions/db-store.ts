import { CONTENT_SCHEMA_VERSION, type ContentError, type Definition, type Kind } from '@adminforge/schemas';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { writeTx, type Db, type Tx } from '../db/client';
import type { Signals } from '../db/signals';
import { definitions } from '../db/schema';
import { AppError } from '../errors';
import { checkStoredBody, definitionUnavailable, rowProblem } from './row-check';
import { compareSemVer, recordKey, type DefinitionRecord, type DefinitionsChanged } from './types';

export const DEFINITIONS_CHANNEL = 'definitions_changed';
/** Signals stay small; larger change sets are sent as `{all:true}` (everything is reloaded). */
const MAX_PAYLOAD = 7000;
const LIVE = ['published', 'retired'];

export interface PublishEntry {
  def: Definition;
  /** sha256 of the source text (loadContentDir). */
  sha256: string;
  source?: 'git' | 'portal';
  authorOid?: string | null;
  approverOid?: string | null;
  /** For messages only. */
  file?: string;
}

export interface PublishItem {
  kind: string;
  key: string;
  version: string;
  /** create = new version row; unchanged = same version and sha256 already published; refused = see reason. */
  action: 'create' | 'unchanged' | 'refused';
  status: 'published' | 'retired';
  reason?: string;
  file?: string;
}

export interface PublishResult {
  items: PublishItem[];
  created: number;
  unchanged: number;
  refused: number;
  /**
   * Unchanged versions whose stored body was rewritten in the authored key order (same content and sha256). Bodies
   * published while the Postgres column was jsonb (and imported as they were) have sorted keys; the next publish
   * restores their order.
   */
  refreshed: number;
  /** Nothing is written when anything is refused (publishing is all-or-nothing). */
  applied: boolean;
  notified: boolean;
  /**
   * Dry runs only: published versions stamped with an older content schema version than this code's, and whether
   * each still passes the current schemas (the API refuses the ones that don't when it loads them).
   */
  olderSchema?: OlderSchemaRow[];
}

/** A published (or retired) version written under an older content schema version. */
export interface OlderSchemaRow {
  kind: string;
  key: string;
  version: string;
  status: 'published' | 'retired';
  schemaVersion: number;
  /** What fails under the current schemas (empty: still valid). */
  problems: string[];
}

type Log = { warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };

export interface DbStoreOptions {
  /** Where refused rows are reported (once per row body). */
  log?: Log | null;
  /** The content schema version stamped on new rows (default CONTENT_SCHEMA_VERSION; tests simulate upgrades). */
  schemaVersion?: number;
}

/** A body's load-time check, remembered by sha256 (see `checked`). */
interface Checked {
  /** The row and body it was checked for: a hit needs both to be the same. */
  ident: string;
  body: string;
  def: Definition | null;
  problems: string[];
}

/** Checked bodies kept per store (one per published version; the oldest are dropped beyond this). */
const MAX_CHECKED = 5000;

export function notifyPayload(keys: string[]): string {
  const json = JSON.stringify({ keys } satisfies DefinitionsChanged);
  return json.length > MAX_PAYLOAD ? JSON.stringify({ all: true } satisfies DefinitionsChanged) : json;
}

interface Meta {
  id: string;
  kind: string;
  key: string;
  version: string;
  sha256: string;
  status: string;
}

/** Highest-precedence version among rows of one key. */
const latestOf = <T extends { version: string }>(rows: T[]): T | undefined =>
  rows.reduce<T | undefined>(
    (best, r) => (!best || compareSemVer(r.version, best.version) > 0 ? r : best),
    undefined,
  );

type Row = typeof definitions.$inferSelect;

const statusOf = (status: string) => (status === 'retired' ? ('retired' as const) : ('published' as const));

/**
 * Published definitions in the database (`definitions` table). Publishing is idempotent per sha256, refuses a version
 * reused with different content (and versions older than the latest), and is all-or-nothing. Every publish that
 * creates rows records the `definitions_changed` signal in the same transaction (every process drops those cache
 * entries).
 */
export class DbDefinitionStore {
  /**
   * Load-time checks by sha256 (S-07). A hit also needs the same row identity and body text: a body rewritten in place
   * (key order restored by publish, or written behind its back) is checked again.
   */
  private readonly checked = new Map<string, Checked>();
  /** Rows refused when loaded, by row id (`problems()`). */
  private readonly refused = new Map<string, ContentError>();
  private readonly log: Log | null;
  private readonly schemaVersion: number;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly signals: Pick<Signals, 'publish' | 'emitLocal'> | null = null,
    opts: DbStoreOptions = {},
  ) {
    this.log = opts.log ?? null;
    this.schemaVersion = opts.schemaVersion ?? CONTENT_SCHEMA_VERSION;
  }

  /**
   * The row as a record, after its body passed its kind's current schema and names its own kind, id and version.
   * Otherwise it is refused: logged once, listed in `problems()`, and a 500 `definition_unavailable` — never used.
   */
  private toRecord(row: Row): DefinitionRecord {
    const ident = `${row.id}\u0000${row.kind}\u0000${row.key}\u0000${row.version}\u0000${row.status}`;
    const body = JSON.stringify(row.body);
    let hit = this.checked.get(row.sha256);
    if (!hit || hit.ident !== ident || hit.body !== body) {
      const check = checkStoredBody(row, row.body);
      hit = { ident, body, def: check.ok ? check.def : null, problems: check.ok ? [] : check.problems };
      this.checked.delete(row.sha256);
      this.checked.set(row.sha256, hit);
      if (this.checked.size > MAX_CHECKED) this.checked.delete(this.checked.keys().next().value!);
      if (!hit.def) {
        const fields = {
          kind: row.kind,
          key: row.key,
          version: row.version,
          sha256: row.sha256,
          schemaVersion: row.schemaVersion,
          issues: hit.problems,
        };
        const msg =
          'published definition refused: its stored body does not pass the content schema (publish the content again)';
        if (this.log?.error) this.log.error(fields, msg);
        else this.log?.warn(fields, msg);
      }
    }
    if (!hit.def) {
      this.refused.set(row.id, rowProblem(row, hit.problems));
      throw definitionUnavailable(row);
    }
    this.refused.delete(row.id);
    return {
      kind: row.kind as Kind,
      key: row.key,
      version: row.version,
      sha256: row.sha256,
      def: hit.def,
      status: statusOf(row.status),
      source: row.source === 'portal' ? 'portal' : 'git',
      publishedAt: row.publishedAt,
      schemaVersion: row.schemaVersion,
    };
  }

  /** Rows refused when they were loaded (they stay refused until a load finds them valid). */
  problems(): ContentError[] {
    return [...this.refused.values()];
  }

  private static plan(entries: PublishEntry[], existing: Meta[]): PublishItem[] {
    const byKey = new Map<string, Meta[]>();
    for (const m of existing) {
      const k = recordKey(m.kind, m.key);
      byKey.set(k, [...(byKey.get(k) ?? []), m]);
    }
    const seen = new Set<string>();
    return entries.map((e) => {
      const kind = e.def.kind;
      const key = e.def.id;
      const version = e.def.version;
      const base = {
        kind,
        key,
        version,
        status: e.def.status === 'retired' ? ('retired' as const) : ('published' as const),
        ...(e.file ? { file: e.file } : {}),
      };
      const id = `${recordKey(kind, key)}@${version}`;
      if (seen.has(id))
        return {
          ...base,
          action: 'refused' as const,
          reason: 'The same kind, id and version appears twice in this publish.',
        };
      seen.add(id);
      const rows = byKey.get(recordKey(kind, key)) ?? [];
      const same = rows.find((r) => r.version === version);
      if (same) {
        return same.sha256 === e.sha256
          ? { ...base, action: 'unchanged' as const }
          : {
              ...base,
              action: 'refused' as const,
              reason: `Version ${version} is already published with different content. Bump the version.`,
            };
      }
      const latest = latestOf(rows.filter((r) => LIVE.includes(r.status)));
      if (latest && compareSemVer(version, latest.version) < 0)
        return {
          ...base,
          action: 'refused' as const,
          reason: `Version ${version} is older than the published ${latest.version}. Use a higher version.`,
        };
      return { ...base, action: 'create' as const };
    });
  }

  private meta(db: Pick<Db, 'select'> | Tx, keys?: string[]): Meta[] {
    const q = db
      .select({
        id: definitions.id,
        kind: definitions.kind,
        key: definitions.key,
        version: definitions.version,
        sha256: definitions.sha256,
        status: definitions.status,
      })
      .from(definitions);
    return (keys ? q.where(inArray(definitions.key, keys)) : q).all();
  }

  /** What `publish` would do, without writing. */
  async plan(entries: PublishEntry[]): Promise<PublishItem[]> {
    if (!entries.length) return [];
    return DbDefinitionStore.plan(entries, this.meta(this.db, [...new Set(entries.map((e) => e.def.id))]));
  }

  async publish(entries: PublishEntry[], opts: { dryRun?: boolean } = {}): Promise<PublishResult> {
    const summary = (items: PublishItem[], applied: boolean, notified: boolean): PublishResult => ({
      items,
      created: items.filter((i) => i.action === 'create').length,
      unchanged: items.filter((i) => i.action === 'unchanged').length,
      refused: items.filter((i) => i.action === 'refused').length,
      refreshed,
      applied,
      notified,
    });
    let refreshed = 0;
    if (opts.dryRun || !entries.length) {
      const items = await this.plan(entries);
      return opts.dryRun
        ? { ...summary(items, false, false), olderSchema: this.olderSchema() }
        : summary(items, false, false);
    }
    // BEGIN IMMEDIATE: one publisher at a time across processes (the CLI, the portal editor).
    const outcome = writeTx(this.db, (tx) => {
      const items = DbDefinitionStore.plan(
        entries,
        this.meta(tx, [...new Set(entries.map((e) => e.def.id))]),
      );
      if (items.some((i) => i.action === 'refused'))
        return { items, applied: false, changed: [] as string[] };
      const now = this.now();
      const restored = this.refreshUnchanged(
        tx,
        entries.filter((_, i) => items[i]!.action === 'unchanged'),
      );
      refreshed = restored.length;
      const creates = entries.filter((_, i) => items[i]!.action === 'create');
      if (creates.length)
        tx.insert(definitions)
          .values(
            creates.map((e) => ({
              kind: e.def.kind,
              key: e.def.id,
              version: e.def.version,
              status: e.def.status === 'retired' ? 'retired' : 'published',
              source: e.source ?? 'git',
              body: e.def,
              sha256: e.sha256,
              schemaVersion: this.schemaVersion,
              authorOid: e.authorOid ?? null,
              approverOid: e.approverOid ?? null,
              createdAt: now,
              publishedAt: now,
            })),
          )
          .run();
      const changed = [
        ...new Set([...creates.map((e) => recordKey(e.def.kind, e.def.id)), ...restored]),
      ].sort();
      // The signal row commits with the versions it announces (or not at all): other processes can't miss it.
      if (changed.length)
        this.signals?.publish(DEFINITIONS_CHANNEL, notifyPayload(changed), { local: false });
      return { items, applied: true, changed };
    });
    // This process's own listeners, once committed.
    const notified = outcome.changed.length > 0 && this.signals !== null;
    if (notified) this.signals!.emitLocal(DEFINITIONS_CHANNEL, notifyPayload(outcome.changed));
    return summary(outcome.items, outcome.applied, notified);
  }

  /**
   * Unchanged versions (same sha256) published again: a stored body that differs from what this publish parsed from
   * the same file (key order from the jsonb era, or defaults a newer schema adds) is rewritten, and the row is stamped
   * with the current content schema version — the body is now exactly what the current schemas made of the file.
   * Returns the record keys whose body changed (only those are announced; a new stamp alone changes nothing served).
   */
  private refreshUnchanged(tx: Tx, unchanged: PublishEntry[]): string[] {
    if (!unchanged.length) return [];
    const rows = tx
      .select({
        id: definitions.id,
        kind: definitions.kind,
        key: definitions.key,
        version: definitions.version,
        body: definitions.body,
        schemaVersion: definitions.schemaVersion,
      })
      .from(definitions)
      .where(inArray(definitions.key, [...new Set(unchanged.map((e) => e.def.id))]))
      .all();
    const restored = new Set<string>();
    for (const e of unchanged) {
      const row = rows.find(
        (r) => r.kind === e.def.kind && r.key === e.def.id && r.version === e.def.version,
      );
      if (!row) continue;
      const sameBody = JSON.stringify(row.body) === JSON.stringify(e.def);
      if (sameBody && row.schemaVersion === this.schemaVersion) continue;
      tx.update(definitions)
        .set(
          sameBody
            ? { schemaVersion: this.schemaVersion }
            : { body: e.def, schemaVersion: this.schemaVersion },
        )
        .where(eq(definitions.id, row.id))
        .run();
      if (!sameBody) restored.add(recordKey(e.def.kind, e.def.id));
    }
    return [...restored].sort();
  }

  /** Published and retired versions stamped with an older content schema version, each checked against the current one. */
  private olderSchema(): OlderSchemaRow[] {
    const rows = this.db
      .select()
      .from(definitions)
      .where(and(lt(definitions.schemaVersion, this.schemaVersion), inArray(definitions.status, LIVE)))
      .all();
    return rows
      .map((row) => {
        const check = checkStoredBody(row, row.body);
        return {
          kind: row.kind,
          key: row.key,
          version: row.version,
          status: statusOf(row.status),
          schemaVersion: row.schemaVersion,
          problems: check.ok ? [] : check.problems,
        };
      })
      .sort(
        (a, b) =>
          recordKey(a.kind, a.key).localeCompare(recordKey(b.kind, b.key)) ||
          compareSemVer(a.version, b.version),
      );
  }

  /** The latest version of `key` when it is retired (null when the latest is published, or nothing is). */
  async retired(kind: Kind, key: string): Promise<DefinitionRecord | null> {
    const latest = latestOf(await this.metasOf(kind, key));
    if (latest?.status !== 'retired') return null;
    const [row] = await this.db.select().from(definitions).where(eq(definitions.id, latest.id)).limit(1);
    return row ? this.toRecord(row) : null;
  }

  /** Id, version and status of every live version of one key. */
  private metasOf(kind: Kind, key: string) {
    return this.db
      .select({ id: definitions.id, version: definitions.version, status: definitions.status })
      .from(definitions)
      .where(and(eq(definitions.kind, kind), eq(definitions.key, key), inArray(definitions.status, LIVE)));
  }

  /** Exact version (published or retired), or the latest version when it is not retired. */
  async get(kind: Kind, key: string, version?: string): Promise<DefinitionRecord | null> {
    if (version) {
      const [row] = await this.db
        .select()
        .from(definitions)
        .where(
          and(
            eq(definitions.kind, kind),
            eq(definitions.key, key),
            eq(definitions.version, version),
            inArray(definitions.status, LIVE),
          ),
        )
        .limit(1);
      return row ? this.toRecord(row) : null;
    }
    const latest = latestOf(await this.metasOf(kind, key));
    if (!latest || latest.status === 'retired') return null;
    const [row] = await this.db.select().from(definitions).where(eq(definitions.id, latest.id)).limit(1);
    return row ? this.toRecord(row) : null;
  }

  /** Latest non-retired version of every key (optionally one kind). */
  async list(kind?: Kind): Promise<DefinitionRecord[]> {
    const metas = await this.db
      .select({
        id: definitions.id,
        kind: definitions.kind,
        key: definitions.key,
        version: definitions.version,
        status: definitions.status,
      })
      .from(definitions)
      .where(
        kind
          ? and(eq(definitions.kind, kind), inArray(definitions.status, LIVE))
          : inArray(definitions.status, LIVE),
      );
    const groups = new Map<string, typeof metas>();
    for (const m of metas)
      groups.set(recordKey(m.kind, m.key), [...(groups.get(recordKey(m.kind, m.key)) ?? []), m]);
    const ids = [...groups.values()]
      .map((g) => latestOf(g)!)
      .filter((m) => m.status !== 'retired')
      .map((m) => m.id);
    if (!ids.length) return [];
    const rows = await this.db.select().from(definitions).where(inArray(definitions.id, ids));
    // A refused row is left out of the list (it is in problems() and the log); the rest are served.
    const records: DefinitionRecord[] = [];
    for (const row of rows) {
      try {
        records.push(this.toRecord(row));
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'definition_unavailable') throw err;
      }
    }
    return records.sort((a, b) => recordKey(a.kind, a.key).localeCompare(recordKey(b.kind, b.key)));
  }

  /** Every version of one key, newest first (history views). */
  async versions(
    kind: Kind,
    key: string,
  ): Promise<Array<Pick<DefinitionRecord, 'version' | 'sha256' | 'status' | 'source' | 'publishedAt'>>> {
    const rows = await this.db
      .select({
        version: definitions.version,
        sha256: definitions.sha256,
        status: definitions.status,
        source: definitions.source,
        publishedAt: definitions.publishedAt,
      })
      .from(definitions)
      .where(and(eq(definitions.kind, kind), eq(definitions.key, key), inArray(definitions.status, LIVE)));
    return rows
      .map((r) => ({
        ...r,
        status: statusOf(r.status),
        source: r.source === 'portal' ? ('portal' as const) : ('git' as const),
      }))
      .sort((a, b) => compareSemVer(b.version, a.version));
  }
}
