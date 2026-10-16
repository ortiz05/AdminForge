import type { Feed, FeedRule, NewsArea, NewsKind, NewsSeverity } from '@adminforge/schemas';
import type { Candidate } from './types';

/**
 * Classification (FeedRule in @adminforge/schemas news.ts): rules run in order; areas and tags add up over every
 * matching rule; kind, severity and status come from the first matching rule that sets them (else the collector's reading); a
 * matching `exclude: true` drops the item. `keep: matched` drops items no rule placed in an area; `keep: all` gives
 * them the feed's defaultAreas.
 */

export interface Classification {
  areas: NewsArea[];
  tags: string[];
  kind: NewsKind;
  severity: NewsSeverity;
  /** From the first matching rule that sets one; null when no rule does (the collector's status then stands). */
  status: string | null;
}

/** What classification reads from a collected item (a Candidate satisfies it). */
export type ClassifiableItem = Pick<
  Candidate,
  'services' | 'categories' | 'title' | 'summary' | 'kind' | 'severity' | 'tags'
>;

const norm = (s: string) => s.trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const phraseCache = new Map<string, RegExp>();
/** Whole word or phrase, case-insensitive: "Teams" matches "Microsoft Teams," but not "Teamsters". */
function phrase(value: string): RegExp {
  let re = phraseCache.get(value);
  if (!re) {
    const words = value.trim().split(/\s+/).map(escape).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu');
    if (phraseCache.size > 2_000) phraseCache.clear();
    phraseCache.set(value, re);
  }
  return re;
}

export function ruleMatches(
  rule: FeedRule,
  c: Pick<Candidate, 'services' | 'categories' | 'title' | 'summary'>,
): boolean {
  const m = rule.match;
  if (m.services?.length) {
    const have = new Set(c.services.map(norm));
    if (m.services.some((v) => have.has(norm(v)))) return true;
  }
  if (m.categories?.length) {
    const have = new Set(c.categories.map(norm));
    if (m.categories.some((v) => have.has(norm(v)))) return true;
  }
  if (m.title?.some((v) => phrase(v).test(c.title))) return true;
  if (m.text?.length) {
    const text = `${c.title} ${c.summary}`;
    if (m.text.some((v) => phrase(v).test(text))) return true;
  }
  return false;
}

/** The item's areas, tags, kind and severity — or null when the feed doesn't keep it. */
export function classify(
  feed: Pick<Feed, 'classify' | 'keep' | 'defaultAreas'>,
  c: ClassifiableItem,
): Classification | null {
  const areas = new Set<NewsArea>();
  const tags = new Set<string>(c.tags);
  let kind: NewsKind | undefined;
  let severity: NewsSeverity | undefined;
  let status: string | undefined;
  for (const rule of feed.classify) {
    if (!ruleMatches(rule, c)) continue;
    if (rule.exclude) return null;
    for (const a of rule.areas ?? []) areas.add(a);
    for (const t of rule.tags ?? []) tags.add(t);
    kind ??= rule.kind;
    severity ??= rule.severity;
    status ??= rule.status;
  }
  if (!areas.size) {
    if (feed.keep === 'matched') return null;
    for (const a of feed.defaultAreas) areas.add(a);
  }
  return {
    areas: [...areas],
    tags: [...tags],
    kind: kind ?? c.kind,
    severity: severity ?? c.severity,
    status: status ?? null,
  };
}
