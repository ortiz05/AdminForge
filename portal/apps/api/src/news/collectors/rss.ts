import { createHash } from 'node:crypto';
import type { FeedCollector, NewsKind } from '@adminforge/schemas';
import { AppError } from '../../errors';
import { htmlToText } from '../text';
import type { Candidate } from '../types';
import { parseFeed, parseFeedDate, type FeedEntry } from '../xml';
import { day, facts, type Collector } from './shared';

/**
 * A public RSS 2.0 / Atom feed on an allow-listed Microsoft host (fetch-feed.ts rules). Only the headline, a short
 * plain-text excerpt (cut later to the feed's excerptChars) and the link are kept; an item without a link cites the
 * feed's homepage. `linkPrefixes` keeps only items whose link starts with one of them; an empty feed is an error
 * unless `allowEmpty`. Every item within lookbackDays is returned, newest first: the service keeps the newest `maxItems`
 * after classification, so a broad feed (MSRC lists thousands of CVEs) still yields every relevant item.
 */

type Rss = Extract<FeedCollector, { kind: 'rss' }>;

const DAY_MS = 86_400_000;

/**
 * The collector's own reading of an item's kind from its title and categories (feed rules can override it):
 * retirement / preview / feature (generally available, launched) / security (CVE) / info.
 */
export function rssKind(title: string, categories: string[]): NewsKind {
  const t = title.toLowerCase();
  const cats = categories.map((c) => c.toLowerCase());
  if (
    /\bretir(e|es|ed|ing|ement)\b|\bdeprecat|\bend of (support|life)\b/.test(t) ||
    cats.some((c) => /retire|deprecat/.test(c))
  )
    return 'retirement';
  if (/\bcve-\d{4}-\d{3,}\b/.test(t) || /\bsecurity (update|advisory|vulnerability)\b/.test(t))
    return 'security';
  if (
    /\bpreview\b/.test(t) ||
    cats.some((c) => c === 'in preview' || c === 'preview' || c === 'public preview')
  )
    return 'preview';
  if (
    /\bgenerally available\b|\bgeneral availability\b|\bnow available\b|^\s*\[?ga\]?\s*[:\-–]|\blaunched\b/.test(
      t,
    ) ||
    cats.some((c) => c === 'launched' || c === 'now available' || c === 'generally available')
  )
    return 'feature';
  return 'info';
}

export function entryToCandidate(e: FeedEntry, now: Date): Candidate | null {
  const title = e.title.trim();
  if (!title) return null;
  const published = parseFeedDate(e.published) ?? parseFeedDate(e.updated) ?? now;
  const updated = parseFeedDate(e.updated);
  const externalId = (
    e.id.trim() ||
    e.link.trim() ||
    `sha256:${createHash('sha256').update(`${title}\n${e.published}`).digest('hex').slice(0, 32)}`
  ).slice(0, 500);
  return {
    externalId,
    title,
    summary: htmlToText(e.summary),
    url: e.link || null,
    kind: rssKind(title, e.categories),
    severity: 'normal',
    status: null,
    publishedAt: published,
    updatedAt: updated && updated.getTime() > published.getTime() ? updated : null,
    actionRequiredBy: null,
    services: [],
    categories: e.categories,
    tags: [],
    audience: [],
    facts: facts([
      ['Published', day(published)],
      ['Updated', updated && updated.getTime() > published.getTime() ? day(updated) : null],
      ['Categories', e.categories.slice(0, 8).join(', ')],
    ]),
  };
}

export const collectRss: Collector<Rss> = async (ctx, deps) => {
  const c = ctx.feed.collector;
  const now = deps.now();
  const res = await deps.fetchFeed(c.url, {
    etag: ctx.state?.etag ?? null,
    lastModified: ctx.state?.lastModified ?? null,
    signal: ctx.signal,
  });
  if (res.status === 'not_modified') return { notModified: true, candidates: [] };
  const parsed = parseFeed(res.text);
  // Some sites answer 200 with an empty "Resource Not Found" channel for a board or feed that doesn't exist.
  if (/^\s*resource not found\s*$/i.test(parsed.title))
    throw new AppError(502, 'feed_not_found', 'The source answered that this feed doesn’t exist.', {
      hint: 'The feed may have moved or been retired. Check the URL in the feed definition against the publisher’s site.',
    });
  const oldest = now.getTime() - c.lookbackDays * DAY_MS;
  const prefixes = c.linkPrefixes;
  const activity = (x: Candidate) => (x.updatedAt ?? x.publishedAt).getTime();
  const all = parsed.entries
    .map((e) => entryToCandidate(e, now))
    .filter((x): x is Candidate => x !== null)
    .filter((x) => !prefixes || (!!x.url && prefixes.some((p) => x.url!.startsWith(p))));
  if (!all.length && !c.allowEmpty)
    throw new AppError(502, 'feed_empty', 'The feed answered but had no items.', {
      hint: 'A moved or retired feed often answers with an empty list. Check the URL (and linkPrefixes) in the feed definition; set allowEmpty: true if the feed is often empty.',
    });
  // One entry per id (MSRC repeats a guid per revision): keep the newest.
  const byId = new Map<string, Candidate>();
  for (const x of all) {
    const seen = byId.get(x.externalId);
    if (!seen || activity(x) > activity(seen)) byId.set(x.externalId, x);
  }
  const candidates = [...byId.values()]
    .filter((x) => activity(x) >= oldest)
    .sort((a, b) => activity(b) - activity(a));
  return { candidates, etag: res.etag, lastModified: res.lastModified };
};
