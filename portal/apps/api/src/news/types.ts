import type { NewsArea, NewsKind, NewsSeverity, PortalRole } from '@adminforge/schemas';

/**
 * News and changes (docs/plans/2026-10-15-news-and-changes.md): what collectors produce, what the store keeps, and the
 * store port (Postgres in production, memory in mock mode and tests).
 */

export interface NewsFact {
  label: string;
  value: string;
}

/** One item as a collector read it, before classification. Text is already plain (never HTML). */
export interface Candidate {
  /** The source's own id: MC123456, EX123456, a tracking id, an RSS guid, Package@1.2.3. */
  externalId: string;
  title: string;
  /** Plain text, not yet cut to the feed's excerpt length. */
  summary: string;
  /** The source's link for this item (kept only when it is a citation URL). */
  url: string | null;
  /** The collector's own reading; classification rules can override kind and severity. */
  kind: NewsKind;
  severity: NewsSeverity;
  /** active / resolved for incidents and maintenance; the source's wording otherwise; null when there is none. */
  status: string | null;
  publishedAt: Date;
  updatedAt: Date | null;
  actionRequiredBy: Date | null;
  /** `services` match field (tenant service names, package ids). */
  services: string[];
  /** `categories` match field (RSS/Atom categories, Message Center tags). */
  categories: string[];
  /** Tags the collector adds itself (e.g. major-change, powershell). */
  tags: string[];
  /** Portal roles the item needs on top of the feed's (e.g. Portal.Admin for data-privacy messages). */
  audience: PortalRole[];
  facts: NewsFact[];
}

/** What collecting one feed produced. */
export interface CollectResult {
  /** The source answered 304: nothing changed since the last collection. */
  notModified?: boolean;
  candidates: Candidate[];
  etag?: string | null;
  lastModified?: string | null;
  /** Something worth knowing that isn't a failure (e.g. Graph ignored the change filter; everything was read). */
  note?: string;
}

/** A classified, normalised item ready to store. */
export interface NewsItemInput {
  feedKey: string;
  externalId: string;
  title: string;
  summary: string;
  url: string;
  kind: NewsKind;
  severity: NewsSeverity;
  areas: NewsArea[];
  tags: string[];
  status: string | null;
  audience: PortalRole[];
  publishedAt: Date;
  updatedAt: Date | null;
  /** coalesce(updatedAt, publishedAt): orders the feed and drives the `days` filter. */
  activityAt: Date;
  actionRequiredBy: Date | null;
  facts: NewsFact[];
  contentHash: string;
}

export interface NewsItemRow extends NewsItemInput {
  id: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  changedAt: Date;
}

export type FeedRunStatus = 'ok' | 'error';

export interface FeedState {
  feedKey: string;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  status: FeedRunStatus | null;
  errorCode: string | null;
  errorMessage: string | null;
  etag: string | null;
  lastModified: string | null;
  items: number;
  newItems: number;
  updatedItems: number;
  durationMs: number | null;
  /** sha256 of the feed definition that produced the last run (a changed definition collects everything again). */
  definitionSha: string | null;
  /** The last successful run's note (CollectResult.note), if any. */
  note: string | null;
}

/** Filters for listing (already validated). `roles` is the caller's: items whose audience they don't hold are hidden. */
export interface NewsFilter {
  roles: readonly string[];
  now: Date;
  area?: NewsArea;
  kind?: NewsKind;
  feed?: string;
  tag?: string;
  q?: string;
  /** activityAt within the last N days. */
  days?: number;
  breaking?: boolean;
  /** Only items changed after this instant (unread). */
  changedAfter?: Date;
  /** Only items of these feeds (the currently defined ones). */
  feeds?: readonly string[];
}

/** Keyset position: the last row of the previous page. */
export interface NewsCursor {
  activityAt: Date;
  id: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/** An unresolved incident outlives its feed's retention only while the source still lists it (seen this recently). */
export const ACTIVE_INCIDENT_SEEN_DAYS = 30;

export interface PrunePolicy {
  now: Date;
  /** Retention days per defined feed. */
  feeds: ReadonlyMap<string, number>;
  /** Items of feeds no longer defined are deleted this many days after they were last seen. */
  orphanDays: number;
}

export interface NewsStore {
  /** Inserts new items and updates existing ones (by feed + external id); `changedAt` moves only when the hash differs. */
  upsert(feedKey: string, items: NewsItemInput[], now: Date): Promise<UpsertResult>;
  list(filter: NewsFilter, page: { limit: number; after?: NewsCursor }): Promise<NewsItemRow[]>;
  get(id: string, roles: readonly string[]): Promise<NewsItemRow | null>;
  /** Visible items matching `filter`, at most `cap` (counting stops there). */
  count(filter: NewsFilter, cap: number): Promise<number>;
  /** Visible items per feed. */
  countByFeed(roles: readonly string[]): Promise<Map<string, number>>;
  /** Every item of a feed, whatever the audience (feed state bookkeeping). */
  totalForFeed(feedKey: string): Promise<number>;
  /** Deletes a feed's items by external id (items its rules no longer keep); returns how many went. */
  remove(feedKey: string, externalIds: readonly string[]): Promise<number>;
  /** Newest activityAt per feed among the items the caller may see. */
  newestByFeed(roles: readonly string[]): Promise<Map<string, Date>>;
  getState(feedKey: string): Promise<FeedState | null>;
  listStates(): Promise<FeedState[]>;
  saveState(state: FeedState): Promise<void>;
  prune(policy: PrunePolicy): Promise<number>;
}
