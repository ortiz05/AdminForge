import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type {
  NewsArea,
  NewsFeedStatus,
  NewsItemDto,
  NewsKind,
  NewsSeverity,
  NewsSummaryResponse,
} from '@adminforge/schemas';
import { api } from '../lib/api';
import { arr, bool, num, parser, query, rec, str } from '../runs/json';
import { AREA_LABEL, KIND_META, SEVERITY_META, type RangeDays } from './model';

/**
 * News and changes — the BFF contract (portal/packages/schemas/src/news.ts):
 *   GET /api/news?area&kind&feed&tag&q&days&breaking&unread&cursor&limit → { items: NewsItem[], nextCursor }
 *   GET /api/news/summary → { unread, breakingUnread, breaking: NewsItem[], lastUpdatedAt, seenAt, feeds }
 *   GET /api/news/:id     → NewsItem
 *   PUT /api/me/prefs { newsSeenAt } — mark everything read.
 * Readers are lenient (this module also ships in the shell bundle, without zod): they keep what they recognise and
 * drop an item only when its core (id, title) is missing. Text stays text — nothing here is ever rendered as HTML.
 */

const AREAS = new Set(Object.keys(AREA_LABEL));
const KINDS = new Set(Object.keys(KIND_META));
const SEVERITIES = new Set(Object.keys(SEVERITY_META));
const strs = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string');

export function readNewsItem(raw: unknown): NewsItemDto | null {
  const o = rec(raw);
  const id = str(o.id);
  const title = str(o.title);
  if (!id || !title) return null;
  const publishedAt = str(o.publishedAt) ?? str(o.firstSeenAt) ?? '';
  const kind = str(o.kind);
  const severity = str(o.severity);
  return {
    id,
    feed: str(o.feed) ?? '',
    feedTitle: str(o.feedTitle) ?? str(o.feed) ?? 'Unknown source',
    publisher: str(o.publisher) ?? '',
    externalId: str(o.externalId) ?? '',
    title,
    summary: str(o.summary) ?? '',
    url: str(o.url) ?? '',
    kind: kind && KINDS.has(kind) ? (kind as NewsKind) : 'info',
    severity: severity && SEVERITIES.has(severity) ? (severity as NewsSeverity) : 'normal',
    areas: strs(o.areas).filter((a): a is NewsArea => AREAS.has(a)),
    tags: strs(o.tags),
    status: str(o.status) ?? null,
    publishedAt,
    updatedAt: str(o.updatedAt) ?? null,
    firstSeenAt: str(o.firstSeenAt) ?? publishedAt,
    changedAt: str(o.changedAt) ?? str(o.firstSeenAt) ?? publishedAt,
    actionRequiredBy: str(o.actionRequiredBy) ?? null,
    breaking: bool(o.breaking) ?? false,
    unread: bool(o.unread) ?? false,
    facts: arr(o.facts)
      .map((f) => ({ label: str(rec(f).label), value: str(rec(f).value) }))
      .filter((f): f is { label: string; value: string } => !!f.label && f.value !== undefined),
  };
}

const FEED_STATUS = new Set(['ok', 'error', 'stale', 'never']);

function readFeed(raw: unknown): NewsFeedStatus | null {
  const o = rec(raw);
  const key = str(o.key);
  if (!key) return null;
  const status = str(o.status);
  const error = rec(o.error);
  return {
    key,
    title: str(o.title) ?? key,
    publisher: str(o.publisher) ?? '',
    homepage: str(o.homepage) ?? '',
    scope: o.scope === 'tenant' ? 'tenant' : 'public',
    status: status && FEED_STATUS.has(status) ? (status as NewsFeedStatus['status']) : 'never',
    lastRunAt: str(o.lastRunAt) ?? null,
    lastSuccessAt: str(o.lastSuccessAt) ?? null,
    pollMinutes: Math.max(1, num(o.pollMinutes) ?? 60),
    newestAt: str(o.newestAt) ?? null,
    quiet: bool(o.quiet) ?? false,
    items: num(o.items) ?? 0,
    error:
      str(error.code) && str(error.message) ? { code: str(error.code)!, message: str(error.message)! } : null,
  };
}

const items = (v: unknown) =>
  arr(v)
    .map(readNewsItem)
    .filter((x): x is NewsItemDto => x !== null);

export const summaryContract = parser<NewsSummaryResponse>((input) => {
  const o = rec(input);
  if (typeof o.unread !== 'number' || !Array.isArray(o.feeds))
    throw new TypeError('Expected { unread, breaking, feeds }');
  return {
    unread: Math.max(0, o.unread),
    breakingUnread: Math.max(0, num(o.breakingUnread) ?? 0),
    breaking: items(o.breaking),
    lastUpdatedAt: str(o.lastUpdatedAt) ?? null,
    seenAt: str(o.seenAt) ?? null,
    feeds: arr(o.feeds)
      .map(readFeed)
      .filter((f): f is NewsFeedStatus => f !== null),
  };
});

const listContract = parser((input) => {
  const o = rec(input);
  if (!Array.isArray(o.items)) throw new TypeError('Expected { items: [] }');
  return { items: items(o.items), nextCursor: str(o.nextCursor) ?? null };
});

const itemContract = parser((input) => {
  const item = readNewsItem(input);
  if (!item) throw new TypeError('Expected a news item');
  return item;
});

/** The shell polls this for the navigation badge and the top-bar pill; `news.updated` refetches it sooner. */
export const newsSummaryQuery = queryOptions({
  queryKey: ['news', 'summary'] as const,
  queryFn: ({ signal }) => api('/api/news/summary', { schema: summaryContract, signal }),
  staleTime: 60_000,
  refetchInterval: 5 * 60_000,
  // A shell decoration: a missing or failing endpoint must never get in the way.
  retry: false,
});

export interface NewsFilter {
  area?: NewsArea;
  kind?: NewsKind;
  feed?: string;
  tag?: string;
  q?: string;
  days: RangeDays;
  breaking?: boolean;
  unread?: boolean;
}

export const NEWS_PAGE_SIZE = 50;

export const newsListQuery = (f: NewsFilter) =>
  infiniteQueryOptions({
    queryKey: ['news', 'list', f] as const,
    queryFn: ({ pageParam, signal }) =>
      api(
        `/api/news${query({
          area: f.area,
          kind: f.kind,
          feed: f.feed,
          tag: f.tag,
          q: f.q,
          days: f.days,
          breaking: f.breaking ? 'true' : undefined,
          unread: f.unread ? 'true' : undefined,
          cursor: pageParam ?? undefined,
          limit: NEWS_PAGE_SIZE,
        })}`,
        { schema: listContract, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5 * 60_000,
  });

export const newsItemQuery = (id: string) =>
  queryOptions({
    queryKey: ['news', 'item', id] as const,
    queryFn: ({ signal }) => api(`/api/news/${encodeURIComponent(id)}`, { schema: itemContract, signal }),
  });

/** "Mark all as read": the server keeps the marker in the person's preferences. */
export async function markAllRead(at: Date = new Date()): Promise<string> {
  const newsSeenAt = at.toISOString();
  await api('/api/me/prefs', { method: 'PUT', body: { newsSeenAt } });
  return newsSeenAt;
}
