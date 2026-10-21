import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client';
import { BREAKING, DAY_MS } from './breaking';
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
 * SQLite store for News and changes (tables news_items, news_feed_state). Parameterised SQL only; the caller's roles
 * filter every read (an item's audience must be a subset of them). Lists (areas, tags, audience) are JSON arrays,
 * instants integer milliseconds (db/schema.ts).
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
  areas: string;
  tags: string;
  status: string | null;
  audience: string;
  published_at: number;
  updated_at: number | null;
  activity_at: number;
  action_required_by: number | null;
  first_seen_at: number;
  last_seen_at: number;
  changed_at: number;
  content_hash: string;
  facts: string;
}

const date = (ms: number) => new Date(ms);
const maybeDate = (ms: number | null) => (ms === null ? null : new Date(ms));
const ms = (d: Date | null) => (d === null ? null : d.getTime());
const parse = <T>(text: string, fallback: T): T => {
  try {
    const v = JSON.parse(text) as unknown;
    return (Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : (v ?? fallback)) as T;
  } catch {
    return fallback;
  }
};

const toRow = (r: ItemDbRow): NewsItemRow => ({
  id: r.id,
  feedKey: r.feed_key,
  externalId: r.external_id,
  title: r.title,
  summary: r.summary,
  url: r.url,
  kind: r.kind,
  severity: r.severity,
  areas: parse<NewsItemRow['areas']>(r.areas, []),
  tags: parse<string[]>(r.tags, []),
  status: r.status,
  audience: parse<NewsItemRow['audience']>(r.audience, []),
  publishedAt: date(r.published_at),
  updatedAt: maybeDate(r.updated_at),
  activityAt: date(r.activity_at),
  actionRequiredBy: maybeDate(r.action_required_by),
  firstSeenAt: date(r.first_seen_at),
  lastSeenAt: date(r.last_seen_at),
  changedAt: date(r.changed_at),
  contentHash: r.content_hash,
  facts: parse<NewsItemRow['facts']>(r.facts, []),
});

interface StateDbRow {
  feed_key: string;
  last_run_at: number | null;
  last_success_at: number | null;
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
  lastRunAt: maybeDate(r.last_run_at),
  lastSuccessAt: maybeDate(r.last_success_at),
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

/** `audience` ⊆ the reader's roles (a JSON array parameter). */
const AUDIENCE_WITHIN = (roles: string) =>
  `not exists (select 1 from json_each(news_items.audience) a where a.value not in (select value from json_each(${roles})))`;

/** The breaking rules of breaking.ts, in SQL. `now` is a bound parameter reference (milliseconds), such as `@p3`. */
export function breakingSql(now: string): string {
  const days = (n: number) => Math.trunc(n) * DAY_MS;
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

type Params = Record<string, string | number | null>;

function where(f: NewsFilter, params: Params, after?: NewsCursor): string {
  const p = (v: string | number | null) => {
    const name = `p${Object.keys(params).length + 1}`;
    params[name] = v;
    return `@${name}`;
  };
  const clauses = [AUDIENCE_WITHIN(p(JSON.stringify([...f.roles])))];
  if (f.feeds) clauses.push(`feed_key in (select value from json_each(${p(JSON.stringify([...f.feeds]))}))`);
  if (f.area)
    clauses.push(`exists (select 1 from json_each(news_items.areas) x where x.value = ${p(f.area)})`);
  if (f.kind) clauses.push(`kind = ${p(f.kind)}`);
  if (f.feed) clauses.push(`feed_key = ${p(f.feed)}`);
  if (f.tag) clauses.push(`exists (select 1 from json_each(news_items.tags) x where x.value = ${p(f.tag)})`);
  if (f.q) {
    // LIKE is case-insensitive for ASCII letters (as ILIKE was; other scripts match case-sensitively).
    const q = p(`%${likeEscape(f.q)}%`);
    clauses.push(`(title like ${q} escape '\\' or summary like ${q} escape '\\')`);
  }
  if (f.days !== undefined) clauses.push(`activity_at >= ${p(f.now.getTime() - f.days * DAY_MS)}`);
  if (f.breaking !== undefined) {
    const sql = breakingSql(p(f.now.getTime()));
    clauses.push(f.breaking ? sql : `not ${sql}`);
  }
  if (f.changedAfter) clauses.push(`changed_at > ${p(f.changedAfter.getTime())}`);
  if (after) clauses.push(`(activity_at, id) < (${p(after.activityAt.getTime())}, ${p(after.id)})`);
  return clauses.join(' and ');
}

export class SqliteNewsStore implements NewsStore {
  constructor(private readonly database: Pick<Database, 'sqlite'>) {}

  private get sqlite() {
    return this.database.sqlite;
  }

  async upsert(feedKey: string, items: NewsItemInput[], now: Date): Promise<UpsertResult> {
    const result: UpsertResult = { inserted: 0, updated: 0 };
    if (!items.length) return result;
    const t = now.getTime();
    const values = (i: NewsItemInput) => ({
      feed_key: feedKey,
      external_id: i.externalId,
      title: i.title,
      summary: i.summary,
      url: i.url,
      kind: i.kind,
      severity: i.severity,
      areas: JSON.stringify(i.areas),
      tags: JSON.stringify(i.tags),
      status: i.status,
      audience: JSON.stringify(i.audience),
      published_at: i.publishedAt.getTime(),
      updated_at: ms(i.updatedAt),
      activity_at: i.activityAt.getTime(),
      action_required_by: ms(i.actionRequiredBy),
      now: t,
      content_hash: i.contentHash,
      facts: JSON.stringify(i.facts),
    });
    const select = this.sqlite.prepare(
      'select external_id, content_hash from news_items where feed_key = ? and external_id in (select value from json_each(?))',
    );
    const insert = this.sqlite.prepare(
      `insert into news_items (id, feed_key, external_id, title, summary, url, kind, severity, areas, tags, status,
         audience, published_at, updated_at, activity_at, action_required_by, first_seen_at, last_seen_at, changed_at,
         content_hash, facts)
       values (@id, @feed_key, @external_id, @title, @summary, @url, @kind, @severity, @areas, @tags, @status, @audience,
         @published_at, @updated_at, @activity_at, @action_required_by, @now, @now, min(@now, @activity_at),
         @content_hash, @facts)
       on conflict (feed_key, external_id) do nothing`,
    );
    const update = this.sqlite.prepare(
      `update news_items set title = @title, summary = @summary, url = @url, kind = @kind, severity = @severity,
         areas = @areas, tags = @tags, status = @status, audience = @audience, published_at = @published_at,
         updated_at = @updated_at, activity_at = @activity_at, action_required_by = @action_required_by,
         last_seen_at = @now, changed_at = @now, content_hash = @content_hash, facts = @facts
       where feed_key = @feed_key and external_id = @external_id`,
    );
    const seen = this.sqlite.prepare(
      'update news_items set last_seen_at = ? where feed_key = ? and external_id in (select value from json_each(?))',
    );
    this.sqlite
      .transaction(() => {
        const existing = new Map<string, string>(
          (
            select.all(feedKey, JSON.stringify(items.map((i) => i.externalId))) as Array<{
              external_id: string;
              content_hash: string;
            }>
          ).map((r) => [r.external_id, r.content_hash]),
        );
        for (const i of items) {
          const hash = existing.get(i.externalId);
          if (hash === undefined) {
            if (insert.run({ id: randomUUID(), ...values(i) }).changes) result.inserted++;
          } else if (hash !== i.contentHash) {
            update.run(values(i));
            result.updated++;
          }
        }
        const unchanged = items
          .filter((i) => existing.get(i.externalId) === i.contentHash)
          .map((i) => i.externalId);
        if (unchanged.length) seen.run(t, feedKey, JSON.stringify(unchanged));
      })
      .immediate();
    return result;
  }

  async list(filter: NewsFilter, page: { limit: number; after?: NewsCursor }): Promise<NewsItemRow[]> {
    const params: Params = {};
    const sql = `select ${ITEM_COLUMNS} from news_items where ${where(filter, params, page.after)}
      order by activity_at desc, id desc limit ${Math.max(1, Math.trunc(page.limit))}`;
    return (this.sqlite.prepare(sql).all(params) as ItemDbRow[]).map(toRow);
  }

  async get(id: string, roles: readonly string[]): Promise<NewsItemRow | null> {
    const row = this.sqlite
      .prepare(`select ${ITEM_COLUMNS} from news_items where id = @id and ${AUDIENCE_WITHIN('@roles')}`)
      .get({ id, roles: JSON.stringify([...roles]) }) as ItemDbRow | undefined;
    return row ? toRow(row) : null;
  }

  async count(filter: NewsFilter, cap: number): Promise<number> {
    const params: Params = {};
    const row = this.sqlite
      .prepare(
        `select count(*) as n from (select 1 from news_items where ${where(filter, params)} limit ${Math.max(1, Math.trunc(cap))})`,
      )
      .get(params) as { n: number };
    return row.n;
  }

  async countByFeed(roles: readonly string[]): Promise<Map<string, number>> {
    const rows = this.sqlite
      .prepare(
        `select feed_key, count(*) as n from news_items where ${AUDIENCE_WITHIN('?')} group by feed_key`,
      )
      .all(JSON.stringify([...roles])) as Array<{ feed_key: string; n: number }>;
    return new Map(rows.map((r) => [r.feed_key, r.n]));
  }

  async newestByFeed(roles: readonly string[]): Promise<Map<string, Date>> {
    const rows = this.sqlite
      .prepare(
        `select feed_key, max(activity_at) as newest from news_items where ${AUDIENCE_WITHIN('?')} group by feed_key`,
      )
      .all(JSON.stringify([...roles])) as Array<{ feed_key: string; newest: number }>;
    return new Map(rows.map((r) => [r.feed_key, new Date(r.newest)]));
  }

  async remove(feedKey: string, externalIds: readonly string[]): Promise<number> {
    if (!externalIds.length) return 0;
    return this.sqlite
      .prepare(
        'delete from news_items where feed_key = ? and external_id in (select value from json_each(?))',
      )
      .run(feedKey, JSON.stringify([...externalIds])).changes;
  }

  async totalForFeed(feedKey: string): Promise<number> {
    const row = this.sqlite
      .prepare('select count(*) as n from news_items where feed_key = ?')
      .get(feedKey) as {
      n: number;
    };
    return row.n;
  }

  async getState(feedKey: string): Promise<FeedState | null> {
    const row = this.sqlite.prepare('select * from news_feed_state where feed_key = ?').get(feedKey) as
      StateDbRow | undefined;
    return row ? toState(row) : null;
  }

  async listStates(): Promise<FeedState[]> {
    return (this.sqlite.prepare('select * from news_feed_state order by feed_key').all() as StateDbRow[]).map(
      toState,
    );
  }

  async saveState(s: FeedState): Promise<void> {
    this.sqlite
      .prepare(
        `insert into news_feed_state (feed_key, last_run_at, last_success_at, status, error_code, error_message, etag,
           last_modified, items, new_items, updated_items, duration_ms, definition_sha, note)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (feed_key) do update set last_run_at = excluded.last_run_at,
           last_success_at = excluded.last_success_at, status = excluded.status, error_code = excluded.error_code,
           error_message = excluded.error_message, etag = excluded.etag, last_modified = excluded.last_modified,
           items = excluded.items, new_items = excluded.new_items, updated_items = excluded.updated_items,
           duration_ms = excluded.duration_ms, definition_sha = excluded.definition_sha, note = excluded.note`,
      )
      .run(
        s.feedKey,
        ms(s.lastRunAt),
        ms(s.lastSuccessAt),
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
      );
  }

  async prune(policy: PrunePolicy): Promise<number> {
    let removed = 0;
    const t = policy.now.getTime();
    const byFeed = this.sqlite.prepare(
      `delete from news_items where feed_key = ? and last_seen_at < ? and activity_at < ?
         and not (kind = 'incident' and coalesce(status, '') <> 'resolved' and last_seen_at >= ?)`,
    );
    for (const [feedKey, days] of policy.feeds) {
      const cutoff = t - days * DAY_MS;
      removed += byFeed.run(feedKey, cutoff, cutoff, t - ACTIVE_INCIDENT_SEEN_DAYS * DAY_MS).changes;
    }
    const orphanCutoff = t - policy.orphanDays * DAY_MS;
    const defined = JSON.stringify([...policy.feeds.keys()]);
    removed += this.sqlite
      .prepare(
        'delete from news_items where feed_key not in (select value from json_each(?)) and last_seen_at < ?',
      )
      .run(defined, orphanCutoff).changes;
    this.sqlite
      .prepare(
        'delete from news_feed_state where feed_key not in (select value from json_each(?)) and coalesce(last_run_at, 0) < ?',
      )
      .run(defined, orphanCutoff);
    return removed;
  }
}
