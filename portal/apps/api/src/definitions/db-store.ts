import type { Definition, Kind } from '@adminforge/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { writeTx, type Db, type Tx } from '../db/client';
import type { Signals } from '../db/signals';
import { definitions } from '../db/schema';
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
}

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

const toRecord = (row: Row): DefinitionRecord => ({
  kind: row.kind as Kind,
  key: row.key,
  version: row.version,
  sha256: row.sha256,
  def: row.body as Definition,
  status: row.status === 'retired' ? 'retired' : 'published',
  source: row.source === 'portal' ? 'portal' : 'git',
  publishedAt: row.publishedAt,
});

/**
 * Published definitions in the database (`definitions` table). Publishing is idempotent per sha256, refuses a version
 * reused with different content (and versions older than the latest), and is all-or-nothing. Every publish that
 * creates rows records the `definitions_changed` signal in the same transaction (every process drops those cache
 * entries).
 */
export class DbDefinitionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly signals: Pick<Signals, 'publish' | 'emitLocal'> | null = null,
  ) {}

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
      return summary(items, false, false);
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
      const restored = this.restoreKeyOrder(
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
   * Rewrites the stored body of unchanged versions (same sha256) whose key order differs from the authored file, and
   * returns their record keys. The content is identical; only the order of object keys is restored.
   */
  private restoreKeyOrder(tx: Tx, unchanged: PublishEntry[]): string[] {
    if (!unchanged.length) return [];
    const rows = tx
      .select({
        id: definitions.id,
        kind: definitions.kind,
        key: definitions.key,
        version: definitions.version,
        body: definitions.body,
      })
      .from(definitions)
      .where(inArray(definitions.key, [...new Set(unchanged.map((e) => e.def.id))]))
      .all();
    const restored = new Set<string>();
    for (const e of unchanged) {
      const row = rows.find(
        (r) => r.kind === e.def.kind && r.key === e.def.id && r.version === e.def.version,
      );
      if (!row || JSON.stringify(row.body) === JSON.stringify(e.def)) continue;
      tx.update(definitions).set({ body: e.def }).where(eq(definitions.id, row.id)).run();
      restored.add(recordKey(e.def.kind, e.def.id));
    }
    return [...restored].sort();
  }

  /** The latest version of `key` when it is retired (null when the latest is published, or nothing is). */
  async retired(kind: Kind, key: string): Promise<DefinitionRecord | null> {
    const latest = latestOf(await this.metasOf(kind, key));
    if (latest?.status !== 'retired') return null;
    const [row] = await this.db.select().from(definitions).where(eq(definitions.id, latest.id)).limit(1);
    return row ? toRecord(row) : null;
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
      return row ? toRecord(row) : null;
    }
    const latest = latestOf(await this.metasOf(kind, key));
    if (!latest || latest.status === 'retired') return null;
    const [row] = await this.db.select().from(definitions).where(eq(definitions.id, latest.id)).limit(1);
    return row ? toRecord(row) : null;
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
    return rows
      .map(toRecord)
      .sort((a, b) => recordKey(a.kind, a.key).localeCompare(recordKey(b.kind, b.key)));
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
        status: r.status === 'retired' ? ('retired' as const) : ('published' as const),
        source: r.source === 'portal' ? ('portal' as const) : ('git' as const),
      }))
      .sort((a, b) => compareSemVer(b.version, a.version));
  }
}
