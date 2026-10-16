import type { FeedCollector } from '@adminforge/schemas';
import type { Candidate, CollectResult } from '../types';
import { collectAzureServiceHealth } from './azure-service-health';
import { collectMessageCenter } from './message-center';
import { collectPsGallery, GALLERY_API } from './ps-gallery';
import { collectRss } from './rss';
import { collectServiceHealth } from './service-health';
import type { CollectContext, CollectorDeps } from './shared';

export type { CollectContext, CollectorDeps } from './shared';

const DAY_MS = 86_400_000;
/** Longest citation link kept (anything longer cites the feed's homepage). */
export const MAX_LINK_CHARS = 2048;

function run(ctx: CollectContext, deps: CollectorDeps): Promise<CollectResult> {
  const kind = ctx.feed.collector.kind;
  const as = <C extends FeedCollector>() => ctx as CollectContext<C>;
  switch (kind) {
    case 'messageCenter':
      return collectMessageCenter(as(), deps);
    case 'serviceHealth':
      return collectServiceHealth(as(), deps);
    case 'azureServiceHealth':
      return collectAzureServiceHealth(as(), deps);
    case 'rss':
      return collectRss(as(), deps);
    case 'psGallery':
      return collectPsGallery(as(), deps);
  }
}

const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Hosts a public feed's items may link to: the feed's own host and its homepage's host. A public feed (RSS, the
 * gallery) can carry links anyone wrote; only links back to the source itself are cited, anything else cites the
 * homepage. Tenant feeds build their links from constants, so they have no host rule. Null = no host rule.
 */
export function sourceHosts(feed: CollectContext['feed']): Set<string> | null {
  const c = feed.collector;
  const own = c.kind === 'rss' ? c.url : c.kind === 'psGallery' ? GALLERY_API : null;
  if (!own) return null;
  return new Set([hostOf(own), hostOf(feed.homepage)].filter((h): h is string => !!h));
}

// eslint-disable-next-line no-control-regex -- a link with control or whitespace characters inside is not cited
const UNSAFE_LINK = /[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** A candidate's link as stored: normalised (`URL.href`), short, without hidden characters, from an allowed host. */
export function citationLink(raw: string | null, hosts: Set<string> | null): string | null {
  const link = (raw ?? '').trim();
  if (!link || link.length > MAX_LINK_CHARS || UNSAFE_LINK.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (hosts && !hosts.has(url.hostname.toLowerCase())) return null;
  return url.href.length > MAX_LINK_CHARS ? null : url.href;
}

/**
 * Source dates can't run ahead of the collection: a publish/update date more than a day in the future would pin the item
 * at the top of every list (and keep it "breaking") — it is taken as now. Deadlines (`actionRequiredBy`) stay as given.
 */
export function clampDates(c: Candidate, now: Date): Candidate {
  const limit = now.getTime() + DAY_MS;
  const publishedAt = c.publishedAt.getTime() > limit ? now : c.publishedAt;
  const updated = c.updatedAt && c.updatedAt.getTime() > limit ? now : c.updatedAt;
  const updatedAt = updated && updated.getTime() > publishedAt.getTime() ? updated : null;
  return { ...c, publishedAt, updatedAt };
}

/** Runs the feed's collector; every candidate then gets the same date and link rules, whatever the source. */
export async function collect(ctx: CollectContext, deps: CollectorDeps): Promise<CollectResult> {
  const out = await run(ctx, deps);
  const now = deps.now();
  const hosts = sourceHosts(ctx.feed);
  return {
    ...out,
    candidates: out.candidates.map((c) => ({ ...clampDates(c, now), url: citationLink(c.url, hosts) })),
  };
}
