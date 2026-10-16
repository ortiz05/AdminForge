import { createHash } from 'node:crypto';
import {
  Feed,
  isCitationUrl,
  isTenantCollector,
  type NewsFeedStatus,
  type NewsItemDto,
  type NewsListQuery,
  type NewsListResponse,
  type NewsSummaryResponse,
  type PortalRole,
} from '@adminforge/schemas';
import { hasRole } from '../auth/guards';
import type { DefinitionRegistry } from '../definitions/types';
import { AppError, toAppError } from '../errors';
import { isBreaking } from './breaking';
import { classify } from './classify';
import { collect, type CollectorDeps } from './collectors';
import { cleanText, cleanTitle, excerpt } from './text';
import type {
  Candidate,
  FeedState,
  NewsCursor,
  NewsFilter,
  NewsItemInput,
  NewsItemRow,
  NewsStore,
} from './types';

/**
 * News and changes: collects every active feed (the scheduler's `news` job), and answers the API (list, one item,
 * summary). See docs/plans/2026-10-15-news-and-changes.md.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A feed with no successful collection for this long (or twice its pollMinutes, if longer) is "stale". */
export const STALE_MS = 3 * HOUR_MS;
/** A feed is due when its last run is at least pollMinutes − 5 minutes old (the hourly tick drifts a little). */
export const POLL_SLACK_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/** One feed's collection may take this long. */
export const FEED_COLLECT_TIMEOUT_MS = 120_000;
/** Without a newsSeenAt, the last 7 days count as unread. */
export const DEFAULT_UNREAD_DAYS = 7;
export const UNREAD_CAP = 99;
const BREAKING_SHOWN = 5;
/** Items of feeds that are no longer defined are deleted this long after they were last seen. */
export const ORPHAN_DAYS = 30;

export interface ActiveFeed {
  key: string;
  feed: Feed;
  sha: string;
}

export interface FeedRefreshResult {
  key: string;
  /** skipped: collected less than pollMinutes ago (not due yet). */
  status: 'ok' | 'failed' | 'skipped';
  /** ok · not_modified · not_due · an error code. */
  code: string;
  new: number;
  updated: number;
}

export interface RefreshResult {
  feeds: number;
  ok: number;
  failed: number;
  skipped: number;
  new: number;
  updated: number;
  results: FeedRefreshResult[];
}

export interface NewsServiceDeps {
  store: NewsStore;
  definitions: Pick<DefinitionRegistry, 'list'>;
  collectors: CollectorDeps;
  now: () => Date;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
  feedTimeoutMs?: number;
}

/** Who is asking: roles filter items by audience; newsSeenAt decides "unread". */
export interface NewsReader {
  roles: readonly string[];
  seenAt: Date | null;
}

const INACTIVE = new Set(['draft', 'retired']);

const sortedCopy = (a: readonly string[]) => [...a].sort();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function contentHash(i: Omit<NewsItemInput, 'contentHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        i.title,
        i.summary,
        i.url,
        i.kind,
        i.severity,
        sortedCopy(i.areas),
        sortedCopy(i.tags),
        i.status,
        sortedCopy(i.audience),
        iso(i.publishedAt),
        iso(i.updatedAt),
        iso(i.actionRequiredBy),
        i.facts,
      ]),
    )
    .digest('hex');
}

/**
 * Tenant feeds run as the automation identity, so a refusal is about its application permissions (or Azure role), not
 * the hint written for a signed-in engineer (Entra role, PIM). Shown to operators on the feed's status.
 */
function forAutomation(feed: Feed, e: AppError): AppError {
  if (e.code !== 'upstream_forbidden' || !isTenantCollector(feed.collector.kind)) return e;
  const needs = [
    ...(feed.requires?.scopes?.graph ?? []).map((s) => `Microsoft Graph ${s}`),
    ...(feed.requires?.azureRoles ?? []).map((r) => `Azure ${r}`),
  ];
  return new AppError(e.status, e.code, 'Microsoft refused the automation identity’s read of this source.', {
    hint: `The automation identity needs ${needs.length ? needs.join(', ') : 'the permissions in the feed’s requires'} (application permission with admin consent; Azure roles on each subscription). Check with pnpm adminforge provision status.`,
  });
}

/** Longest citation link kept; anything longer cites the feed's homepage. */
export const MAX_LINK_CHARS = 2048;

/** The normalised form of an allowed citation link (https, Microsoft domain, no control characters), or null. */
function citation(raw: string | null | undefined): string | null {
  // No whitespace or control characters anywhere (C0, DEL, C1): a link with them is not cited as is.
  const unsafe = (ch: string) => {
    const c = ch.charCodeAt(0);
    return c <= 0x20 || (c >= 0x7f && c <= 0x9f) || /\s/.test(ch);
  };
  if (!raw || raw.length > MAX_LINK_CHARS || [...raw].some(unsafe)) return null;
  try {
    const href = new URL(raw).href;
    return href.length <= MAX_LINK_CHARS && isCitationUrl(href) ? href : null;
  } catch {
    return null;
  }
}

/** A collected candidate → the stored item, or null when the feed doesn't keep it. */
export function normalise(feedKey: string, feed: Feed, c: Candidate): NewsItemInput | null {
  const cls = classify(feed, c);
  if (!cls) return null;
  const title = cleanTitle(c.title);
  const externalId = cleanText(c.externalId).slice(0, 500);
  if (!title || !externalId) return null;
  const audience = [...new Set<PortalRole>([...(feed.requires?.portalRoles ?? []), ...c.audience])];
  const base = {
    feedKey,
    externalId,
    title,
    summary: excerpt(c.summary, feed.excerptChars),
    url: citation(c.url) ?? feed.homepage,
    kind: cls.kind,
    severity: cls.severity,
    areas: cls.areas,
    tags: cls.tags,
    status: (cls.status ?? c.status) ? cleanText((cls.status ?? c.status)!).slice(0, 60) : null,
    audience,
    publishedAt: c.publishedAt,
    updatedAt: c.updatedAt,
    activityAt: c.updatedAt ?? c.publishedAt,
    actionRequiredBy: c.actionRequiredBy,
    facts: c.facts.slice(0, 12),
  };
  return { ...base, contentHash: contentHash(base) };
}

const encodeCursor = (r: NewsItemRow) =>
  Buffer.from(JSON.stringify({ a: r.activityAt.toISOString(), i: r.id })).toString('base64url');

export function decodeCursor(raw: string): NewsCursor {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown };
    const at = typeof v.a === 'string' ? new Date(v.a) : null;
    if (
      at &&
      Number.isFinite(at.getTime()) &&
      typeof v.i === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.i)
    )
      return { activityAt: at, id: v.i.toLowerCase() };
  } catch {
    // fall through
  }
  throw new AppError(400, 'invalid_request', 'The page position in the news list is not valid.', {
    hint: 'Reload News and changes to start from the newest items.',
  });
}

export class NewsService {
  constructor(private readonly deps: NewsServiceDeps) {}

  get store(): NewsStore {
    return this.deps.store;
  }

  /** Published feed definitions that aren't draft or retired, with their defaults applied. */
  async activeFeeds(): Promise<ActiveFeed[]> {
    const out: ActiveFeed[] = [];
    for (const r of await this.deps.definitions.list('feed')) {
      const parsed = Feed.safeParse(r.def);
      if (!parsed.success || INACTIVE.has(parsed.data.status ?? 'active')) continue;
      out.push({ key: r.key, feed: parsed.data, sha: r.sha256 });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Collects the active feeds that are due (last run at least pollMinutes − 5 min ago), or exactly `refs` (forced,
   * whatever their pollMinutes). Counts only — never item content — in the result.
   */
  async refresh(
    opts: {
      refs?: string[];
      concurrency?: number;
      signal?: AbortSignal;
      correlationId?: string;
      /** Time the whole run may take (the schedule's timeout): no feed starts unless it can finish within it. */
      budgetMs?: number;
    } = {},
  ): Promise<RefreshResult> {
    const startedAt = performance.now();
    const feedTimeout = this.deps.feedTimeoutMs ?? FEED_COLLECT_TIMEOUT_MS;
    const active = await this.activeFeeds();
    const states = new Map((await this.deps.store.listStates()).map((s) => [s.feedKey, s]));
    const results: FeedRefreshResult[] = (opts.refs ?? [])
      .filter((k) => !active.some((f) => f.key === k))
      .map((key) => ({ key, status: 'failed' as const, code: 'feed_not_found', new: 0, updated: 0 }));
    let selected = active;
    if (opts.refs) selected = active.filter((f) => opts.refs!.includes(f.key));
    else {
      const now = this.deps.now().getTime();
      selected = active.filter((f) => {
        const last = states.get(f.key)?.lastRunAt?.getTime();
        const due = last === undefined || now - last >= f.feed.pollMinutes * MINUTE_MS - POLL_SLACK_MS;
        if (!due) results.push({ key: f.key, status: 'skipped', code: 'not_due', new: 0, updated: 0 });
        return due;
      });
    }
    // Longest without a successful collection first, so a feed that keeps hanging can't starve the rest hour after hour.
    const lastSuccess = (key: string) => states.get(key)?.lastSuccessAt?.getTime() ?? -1;
    selected = [...selected].sort(
      (a, b) => lastSuccess(a.key) - lastSuccess(b.key) || a.key.localeCompare(b.key),
    );
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        if (opts.signal?.aborted) return;
        const f = selected[next++]!;
        if (opts.budgetMs !== undefined && performance.now() - startedAt + feedTimeout > opts.budgetMs) {
          results.push({ key: f.key, status: 'skipped', code: 'out_of_time', new: 0, updated: 0 });
          continue;
        }
        results.push(await this.refreshFeed(f, opts));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 3), selected.length) }, worker),
    );
    if (opts.signal?.aborted) throw opts.signal.reason;
    results.sort((a, b) => a.key.localeCompare(b.key));
    return {
      feeds: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      new: results.reduce((n, r) => n + r.new, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      results,
    };
  }

  private async refreshFeed(
    f: ActiveFeed,
    opts: { signal?: AbortSignal; correlationId?: string },
  ): Promise<FeedRefreshResult> {
    const { store } = this.deps;
    const started = this.deps.now();
    const t0 = performance.now();
    const previous = await store.getState(f.key);
    // A changed definition (new rules, new URL) collects everything again, without conditional GET.
    const state = previous && previous.definitionSha === f.sha ? previous : null;
    const timeout = AbortSignal.timeout(this.deps.feedTimeoutMs ?? FEED_COLLECT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const base: FeedState = {
      feedKey: f.key,
      lastRunAt: started,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      status: 'error',
      errorCode: null,
      errorMessage: null,
      etag: previous?.etag ?? null,
      lastModified: previous?.lastModified ?? null,
      items: previous?.items ?? 0,
      newItems: 0,
      updatedItems: 0,
      durationMs: null,
      definitionSha: previous?.definitionSha ?? null,
      note: previous?.note ?? null,
    };
    try {
      const out = await collect(
        {
          feedKey: f.key,
          feed: f.feed,
          state,
          signal,
          ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
        },
        this.deps.collectors,
      );
      const now = this.deps.now();
      const byId = new Map<string, NewsItemInput>();
      // Items the source still lists but the feed's rules no longer keep (a rule was tightened): removed, not left
      // until retention.
      const dropped = new Set<string>();
      for (const c of out.candidates) {
        const item = normalise(f.key, f.feed, c);
        if (!item) {
          const id = cleanText(c.externalId).slice(0, 500);
          if (id) dropped.add(id);
          continue;
        }
        const seen = byId.get(item.externalId);
        if (!seen || item.activityAt.getTime() > seen.activityAt.getTime()) byId.set(item.externalId, item);
      }
      // The cap applies to what the feed keeps (after classification), newest first.
      const cap = 'maxItems' in f.feed.collector ? f.feed.collector.maxItems : Number.POSITIVE_INFINITY;
      const kept = [...byId.values()]
        .sort((a, b) => b.activityAt.getTime() - a.activityAt.getTime())
        .slice(0, cap);
      const upserted = out.notModified ? { inserted: 0, updated: 0 } : await store.upsert(f.key, kept, now);
      if (!out.notModified)
        await store.remove(
          f.key,
          [...dropped].filter((id) => !byId.has(id)),
        );
      await store.saveState({
        ...base,
        lastSuccessAt: now,
        status: 'ok',
        etag: out.notModified ? (state?.etag ?? null) : (out.etag ?? null),
        lastModified: out.notModified ? (state?.lastModified ?? null) : (out.lastModified ?? null),
        items: await store.totalForFeed(f.key),
        newItems: upserted.inserted,
        updatedItems: upserted.updated,
        durationMs: Math.round(performance.now() - t0),
        definitionSha: f.sha,
        note: out.note ? cleanText(out.note).slice(0, 300) : null,
      });
      return {
        key: f.key,
        status: 'ok',
        code: out.notModified ? 'not_modified' : 'ok',
        new: upserted.inserted,
        updated: upserted.updated,
      };
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      const e = timeout.aborted
        ? new AppError(
            504,
            'feed_timeout',
            `Collecting the feed took longer than ${Math.round((this.deps.feedTimeoutMs ?? FEED_COLLECT_TIMEOUT_MS) / 1000)} seconds.`,
            {
              hint: 'The next hourly run tries again.',
            },
          )
        : forAutomation(f.feed, toAppError(err));
      const message = cleanText([e.message, e.extras.hint].filter(Boolean).join(' ')).slice(0, 600);
      this.deps.log?.warn({ feed: f.key, code: e.code }, 'news feed collection failed');
      await store
        .saveState({
          ...base,
          errorCode: e.code,
          errorMessage: message,
          durationMs: Math.round(performance.now() - t0),
        })
        .catch(() => undefined);
      return { key: f.key, status: 'failed', code: e.code, new: 0, updated: 0 };
    }
  }

  /** Collects once when nothing was ever collected (DATA_MODE=fixtures start-up, so mock mode has news). */
  async seedIfEmpty(): Promise<RefreshResult | null> {
    if ((await this.deps.store.listStates()).length) return null;
    return this.refresh();
  }

  private seen(reader: NewsReader, now: Date): Date {
    return reader.seenAt ?? new Date(now.getTime() - DEFAULT_UNREAD_DAYS * DAY_MS);
  }

  private toDto(r: NewsItemRow, feeds: Map<string, ActiveFeed>, now: Date, seen: Date): NewsItemDto {
    const f = feeds.get(r.feedKey)?.feed;
    return {
      id: r.id,
      feed: r.feedKey,
      feedTitle: f?.title ?? r.feedKey,
      publisher: f?.publisher ?? '',
      externalId: r.externalId,
      title: r.title,
      summary: r.summary,
      url: r.url,
      kind: r.kind,
      severity: r.severity,
      areas: r.areas,
      tags: r.tags,
      status: r.status,
      publishedAt: r.publishedAt.toISOString(),
      updatedAt: iso(r.updatedAt),
      firstSeenAt: r.firstSeenAt.toISOString(),
      changedAt: r.changedAt.toISOString(),
      actionRequiredBy: iso(r.actionRequiredBy),
      breaking: isBreaking(r, now),
      unread: r.changedAt.getTime() > seen.getTime(),
      facts: r.facts,
    };
  }

  /**
   * The active feeds this reader may see: a feed's requires.portalRoles (every listed role) applies to all of its items
   * at read time, whatever audience they were stored with.
   */
  private async visibleFeeds(roles: readonly string[]): Promise<ActiveFeed[]> {
    return (await this.activeFeeds()).filter((f) =>
      (f.feed.requires?.portalRoles ?? []).every((r) => hasRole({ roles: [...roles] }, r)),
    );
  }

  private async feedMap(roles: readonly string[]): Promise<Map<string, ActiveFeed>> {
    return new Map((await this.visibleFeeds(roles)).map((f) => [f.key, f]));
  }

  async list(reader: NewsReader, q: NewsListQuery): Promise<NewsListResponse> {
    const now = this.deps.now();
    const feeds = await this.feedMap(reader.roles);
    const seen = this.seen(reader, now);
    const filter: NewsFilter = {
      roles: reader.roles,
      now,
      feeds: [...feeds.keys()],
      ...(q.area ? { area: q.area } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.feed ? { feed: q.feed } : {}),
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.q ? { q: q.q } : {}),
      days: q.days,
      ...(q.breaking ? { breaking: q.breaking === 'true' } : {}),
      ...(q.unread === 'true' ? { changedAfter: seen } : {}),
    };
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await this.deps.store.list(filter, { limit: q.limit + 1, ...(after ? { after } : {}) });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => this.toDto(r, feeds, now, seen)),
      nextCursor: rows.length > q.limit && page.length ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  async get(reader: NewsReader, id: string): Promise<NewsItemDto | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const feeds = await this.feedMap(reader.roles);
    const row = await this.deps.store.get(id.toLowerCase(), reader.roles);
    if (!row || !feeds.has(row.feedKey)) return null;
    const now = this.deps.now();
    return this.toDto(row, feeds, now, this.seen(reader, now));
  }

  async summary(reader: NewsReader, opts: { showErrors: boolean }): Promise<NewsSummaryResponse> {
    const now = this.deps.now();
    const active = await this.visibleFeeds(reader.roles);
    const feeds = new Map(active.map((f) => [f.key, f]));
    const keys = [...feeds.keys()];
    const seen = this.seen(reader, now);
    const base: NewsFilter = { roles: reader.roles, now, feeds: keys };
    const [unread, breakingUnread, breaking, states, counts, newest] = await Promise.all([
      this.deps.store.count({ ...base, changedAfter: seen }, UNREAD_CAP),
      this.deps.store.count({ ...base, breaking: true, changedAfter: seen }, UNREAD_CAP),
      this.deps.store.list({ ...base, breaking: true }, { limit: BREAKING_SHOWN }),
      this.deps.store.listStates(),
      this.deps.store.countByFeed(reader.roles),
      this.deps.store.newestByFeed(reader.roles),
    ]);
    const stateOf = new Map(states.map((s) => [s.feedKey, s]));
    const statuses: NewsFeedStatus[] = active
      .map(({ key, feed }) => {
        const s = stateOf.get(key);
        const staleMs = Math.max(STALE_MS, 2 * feed.pollMinutes * MINUTE_MS);
        const status: NewsFeedStatus['status'] = !s
          ? 'never'
          : s.status === 'error'
            ? 'error'
            : !s.lastSuccessAt || now.getTime() - s.lastSuccessAt.getTime() > staleMs
              ? 'stale'
              : 'ok';
        const newestAt = newest.get(key) ?? null;
        return {
          key,
          title: feed.title,
          publisher: feed.publisher,
          homepage: feed.homepage,
          scope: isTenantCollector(feed.collector.kind) ? ('tenant' as const) : ('public' as const),
          status,
          lastRunAt: iso(s?.lastRunAt ?? null),
          lastSuccessAt: iso(s?.lastSuccessAt ?? null),
          pollMinutes: feed.pollMinutes,
          newestAt: iso(newestAt),
          quiet:
            !!feed.quietAfterDays &&
            !!newestAt &&
            now.getTime() - newestAt.getTime() > feed.quietAfterDays * DAY_MS,
          items: counts.get(key) ?? 0,
          error:
            opts.showErrors && s?.status === 'error'
              ? {
                  code: s.errorCode ?? 'feed_failed',
                  message: s.errorMessage ?? 'The last collection failed.',
                }
              : null,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const lastSuccess = states
      .filter((s) => feeds.has(s.feedKey) && s.lastSuccessAt)
      .reduce<Date | null>((m, s) => (!m || s.lastSuccessAt! > m ? s.lastSuccessAt! : m), null);
    return {
      unread,
      breakingUnread,
      breaking: breaking.map((r) => this.toDto(r, feeds, now, seen)),
      lastUpdatedAt: iso(lastSuccess),
      seenAt: iso(reader.seenAt),
      feeds: statuses,
    };
  }

  /** Retention (housekeeping): per-feed retentionDays; items of feeds no longer defined after ORPHAN_DAYS. */
  async prune(now: Date): Promise<number> {
    const defined = new Map<string, number>();
    for (const r of await this.deps.definitions.list('feed')) {
      const parsed = Feed.safeParse(r.def);
      defined.set(r.key, parsed.success ? parsed.data.retentionDays : 180);
    }
    return this.deps.store.prune({ now, feeds: defined, orphanDays: ORPHAN_DAYS });
  }
}
