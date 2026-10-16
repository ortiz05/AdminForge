import type { Database } from '../db/client';
import { BREAKING } from './breaking';
import { ACTIVE_INCIDENT_SEEN_DAYS } from './types';
import type {
  FeedState,
  NewsCursor,
  NewsFilter,
  NewsItemInput,
  NewsItemRow,
  NewsStore,
  PrunePolicy,
  UpsertResult,
} from './types';

/**
 * Postgres store for News and changes (tables news_items, news_feed_state; migration 0006_news). Parameterised SQL
 * only; the caller's roles filter every read (an item's audience must be a subset of them).
 */

const ITEM_COLUMNS = `id, feed_key, external_id, title, summary, url, kind, severity, areas, tags, status, audience,
  published_at, updated_at, activity_at, action_required_by, first_seen_at, last_seen_at, changed_at, content_hash, facts`;

interface ItemDbRow {
  id: string;
  feed_key: string;
  external_id: string;
  title: string;
  summary: string;
  url: string;
  kind: NewsItemRow['kind'];
  severity: NewsItemRow['severity'];
  areas: NewsItemRow['areas'];
  tags: string[];
  status: string | null;
  audience: NewsItemRow['audience'];
  published_at: Date;
  updated_at: Date | null;
  activity_at: Date;
  action_required_by: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  changed_at: Date;
  content_hash: string;
  facts: NewsItemRow['facts'];
}

const toRow = (r: ItemDbRow): NewsItemRow => ({
  id: r.id,
  feedKey: r.feed_key,
  externalId: r.external_id,
  title: r.title,
  summary: r.summary,
  url: r.url,
  kind: r.kind,
  severity: r.severity,
  areas: r.areas,
  tags: r.tags,
  status: r.status,
  audience: r.audience,
  publishedAt: r.published_at,
  updatedAt: r.updated_at,
  activityAt: r.activity_at,
  actionRequiredBy: r.action_required_by,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  changedAt: r.changed_at,
  contentHash: r.content_hash,
  facts: Array.isArray(r.facts) ? r.facts : [],
});

interface StateDbRow {
  feed_key: string;
  last_run_at: Date | null;
  last_success_at: Date | null;
  status: FeedState['status'];
  error_code: string | null;
  error_message: string | null;
  etag: string | null;
  last_modified: string | null;
  items: number;
  new_items: number;
  updated_items: number;
  duration_ms: number | null;
  definition_sha: string | null;
  note: string | null;
}

const toState = (r: StateDbRow): FeedState => ({
  feedKey: r.feed_key,
  lastRunAt: r.last_run_at,
  lastSuccessAt: r.last_success_at,
  status: r.status,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  etag: r.etag,
  lastModified: r.last_modified,
  items: r.items,
  newItems: r.new_items,
  updatedItems: r.updated_items,
  durationMs: r.duration_ms,
  definitionSha: r.definition_sha,
  note: r.note,
});

/** `%`, `_` and `\` are literal in a search. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The breaking rules of breaking.ts, in SQL. `now` is a bound parameter reference such as `$3`. */
export function breakingSql(now: string): string {
  const days = (n: number) => `interval '${Math.trunc(n)} days'`;
  return `(
    (kind = 'incident' and coalesce(status, '') <> 'resolved'
        and activity_at >= ${now} - ${days(BREAKING.incidentDays)})
    or (kind = 'security' and severity in ('critical', 'high') and activity_at >= ${now} - ${days(BREAKING.securityDays)})
    or (kind in ('advisory', 'change', 'retirement') and severity in ('critical', 'high')
        and activity_at >= ${now} - ${days(BREAKING.urgentDays)})
    or (action_required_by is not null and action_required_by >= ${now}
        and action_required_by <= ${now} + ${days(BREAKING.actionWindowDays)}
        and activity_at >= ${now} - ${days(BREAKING.actionWindowDays)})
    or (kind = 'maintenance' and coalesce(status, '') <> 'resolved' and action_required_by >= ${now}
        and action_required_by <= ${now} + ${days(BREAKING.maintenanceDays)})
  )`;
}

function where(f: NewsFilter, params: unknown[], after?: NewsCursor): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const clauses = [`audience <@ ${p([...f.roles])}::text[]`];
  if (f.feeds) clauses.push(`feed_key = any(${p([...f.feeds])}::text[])`);
  if (f.area) clauses.push(`${p(f.area)} = any(areas)`);
  if (f.kind) clauses.push(`kind = ${p(f.kind)}`);
  if (f.feed) clauses.push(`feed_key = ${p(f.feed)}`);
  if (f.tag) clauses.push(`${p(f.tag)} = any(tags)`);
  if (f.q) {
    const q = p(`%${likeEscape(f.q)}%`);
    clauses.push(`(title ilike ${q} or summary ilike ${q})`);
  }
  if (f.days !== undefined)
    clauses.push(`activity_at >= ${p(new Date(f.now.getTime() - f.days * 86_400_000))}::timestamptz`);
  if (f.breaking !== undefined) {
    const sql = breakingSql(`${p(f.now)}::timestamptz`);
    clauses.push(f.breaking ? sql : `not ${sql}`);
  }
  if (f.changedAfter) clauses.push(`changed_at > ${p(f.changedAfter)}::timestamptz`);
  if (after) clauses.push(`(activity_at, id) < (${p(after.activityAt)}::timestamptz, ${p(after.id)}::uuid)`);
  return clauses.join(' and ');
}

export class PgNewsStore implements NewsStore {
  constructor(private readonly database: Database) {}

  private get pool() {
    return this.database.pool;
  }

  async upsert(feedKey: string, items: NewsItemInput[], now: Date): Promise<UpsertResult> {
    const result: UpsertResult = { inserted: 0, updated: 0 };
    if (!items.length) return result;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = new Map<string, string>(
        (
          await client.query<{ external_id: string; content_hash: string }>(
            'select external_id, content_hash from news_items where feed_key = $1 and external_id = any($2::text[]) for update',
            [feedKey, items.map((i) => i.externalId)],
          )
        ).rows.map((r) => [r.external_id, r.content_hash]),
      );
      for (const i of items) {
        const hash = existing.get(i.externalId);
        if (hash === undefined) {
          await client.query(
            `insert into news_items (feed_key, external_id, title, summary, url, kind, severity, areas, tags, status,
               audience, published_at, updated_at, activity_at, action_required_by, first_seen_at, last_seen_at,
               changed_at, content_hash, facts)
             values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10, $11::text[], $12, $13, $14, $15, $16, $16,
               least($16::timestamptz, $14::timestamptz), $17, $18::jsonb)
             on conflict (feed_key, external_id) do nothing`,
            [
              feedKey,
              i.externalId,
              i.title,
              i.summary,
              i.url,
              i.kind,
              i.severity,
              i.areas,
              i.tags,
              i.status,
              i.audience,
              i.publishedAt,
              i.updatedAt,
              i.activityAt,
              i.actionRequiredBy,
              now,
              i.contentHash,
              JSON.stringify(i.facts),
            ],
          );
          result.inserted++;
        } else if (hash !== i.contentHash) {
          await client.query(
            `update news_items set title = $3, summary = $4, url = $5, kind = $6, severity = $7, areas = $8::text[],
               tags = $9::text[], status = $10, audience = $11::text[], published_at = $12, updated_at = $13,
               activity_at = $14, action_required_by = $15, last_seen_at = $16, changed_at = $16, content_hash = $17,
               facts = $18::jsonb
             where feed_key = $1 and external_id = $2`,
            [
              feedKey,
              i.externalId,
              i.title,
              i.summary,
              i.url,
              i.kind,
              i.severity,
              i.areas,
              i.tags,
              i.status,
              i.audience,
              i.publishedAt,
              i.updatedAt,
              i.activityAt,
              i.actionRequiredBy,
              now,
              i.contentHash,
              JSON.stringify(i.facts),
            ],
          );
          result.updated++;
        }
      }
      const unchanged = items
        .filter((i) => existing.get(i.externalId) === i.contentHash)
        .map((i) => i.externalId);
      if (unchanged.length)
        await client.query(
          'update news_items set last_seen_at = $3 where feed_key = $1 and external_id = any($2::text[])',
          [feedKey, unchanged, now],
        );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return result;
  }

  async list(filter: NewsFilter, page: { limit: number; after?: NewsCursor }): Promise<NewsItemRow[]> {
    const params: unknown[] = [];
    const sql = `select ${ITEM_COLUMNS} from news_items where ${where(filter, params, page.after)}
      order by activity_at desc, id desc limit ${Math.max(1, Math.trunc(page.limit))}`;
    const { rows } = await this.pool.query<ItemDbRow>(sql, params);
    return rows.map(toRow);
  }

  async get(id: string, roles: readonly string[]): Promise<NewsItemRow | null> {
    const { rows } = await this.pool.query<ItemDbRow>(
      `select ${ITEM_COLUMNS} from news_items where id = $1::uuid and audience <@ $2::text[]`,
      [id, [...roles]],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async count(filter: NewsFilter, cap: number): Promise<number> {
    const params: unknown[] = [];
    const { rows } = await this.pool.query<{ n: string }>(
      `select count(*) as n from (select 1 from news_items where ${where(filter, params)} limit ${Math.max(1, Math.trunc(cap))}) s`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async countByFeed(roles: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await this.pool.query<{ feed_key: string; n: string }>(
      'select feed_key, count(*) as n from news_items where audience <@ $1::text[] group by feed_key',
      [[...roles]],
    );
    return new Map(rows.map((r) => [r.feed_key, Number(r.n)]));
  }

  async newestByFeed(roles: readonly string[]): Promise<Map<string, Date>> {
    const { rows } = await this.pool.query<{ feed_key: string; newest: Date }>(
      'select feed_key, max(activity_at) as newest from news_items where audience <@ $1::text[] group by feed_key',
      [[...roles]],
    );
    return new Map(rows.map((r) => [r.feed_key, r.newest]));
  }

  async remove(feedKey: string, externalIds: readonly string[]): Promise<number> {
    if (!externalIds.length) return 0;
    const r = await this.pool.query(
      'delete from news_items where feed_key = $1 and external_id = any($2::text[])',
      [feedKey, [...externalIds]],
    );
    return r.rowCount ?? 0;
  }

  async totalForFeed(feedKey: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'select count(*) as n from news_items where feed_key = $1',
      [feedKey],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getState(feedKey: string): Promise<FeedState | null> {
    const { rows } = await this.pool.query<StateDbRow>('select * from news_feed_state where feed_key = $1', [
      feedKey,
    ]);
    return rows[0] ? toState(rows[0]) : null;
  }

  async listStates(): Promise<FeedState[]> {
    const { rows } = await this.pool.query<StateDbRow>('select * from news_feed_state order by feed_key');
    return rows.map(toState);
  }

  async saveState(s: FeedState): Promise<void> {
    await this.pool.query(
      `insert into news_feed_state (feed_key, last_run_at, last_success_at, status, error_code, error_message, etag,
         last_modified, items, new_items, updated_items, duration_ms, definition_sha, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (feed_key) do update set last_run_at = excluded.last_run_at,
         last_success_at = excluded.last_success_at, status = excluded.status, error_code = excluded.error_code,
         error_message = excluded.error_message, etag = excluded.etag, last_modified = excluded.last_modified,
         items = excluded.items, new_items = excluded.new_items, updated_items = excluded.updated_items,
         duration_ms = excluded.duration_ms, definition_sha = excluded.definition_sha, note = excluded.note`,
      [
        s.feedKey,
        s.lastRunAt,
        s.lastSuccessAt,
        s.status,
        s.errorCode,
        s.errorMessage,
        s.etag,
        s.lastModified,
        s.items,
        s.newItems,
        s.updatedItems,
        s.durationMs,
        s.definitionSha,
        s.note,
      ],
    );
  }

  async prune(policy: PrunePolicy): Promise<number> {
    let removed = 0;
    const day = 86_400_000;
    const t = policy.now.getTime();
    for (const [feedKey, days] of policy.feeds) {
      const cutoff = new Date(t - days * day);
      const r = await this.pool.query(
        `delete from news_items where feed_key = $1 and last_seen_at < $2 and activity_at < $2
           and not (kind = 'incident' and coalesce(status, '') <> 'resolved' and last_seen_at >= $3)`,
        [feedKey, cutoff, new Date(t - ACTIVE_INCIDENT_SEEN_DAYS * day)],
      );
      removed += r.rowCount ?? 0;
    }
    const orphanCutoff = new Date(t - policy.orphanDays * day);
    const defined = [...policy.feeds.keys()];
    const r = await this.pool.query(
      'delete from news_items where not (feed_key = any($1::text[])) and last_seen_at < $2',
      [defined, orphanCutoff],
    );
    removed += r.rowCount ?? 0;
    await this.pool.query(
      'delete from news_feed_state where not (feed_key = any($1::text[])) and coalesce(last_run_at, to_timestamp(0)) < $2',
      [defined, orphanCutoff],
    );
    return removed;
  }
}
