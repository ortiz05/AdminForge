import { createFileRoute } from '@tanstack/react-router';
import type { NewsArea, NewsKind } from '@adminforge/schemas';
import { NewsPage, type NewsSearch } from '../news/NewsPage';
import { AREA_LABEL, DEFAULT_DAYS, KIND_META, RANGES, type RangeDays } from '../news/model';

const oneOf = <T extends string>(map: Record<T, unknown>, v: unknown): T | undefined =>
  typeof v === 'string' && Object.hasOwn(map, v) ? (v as T) : undefined;
const flag = (v: unknown) => (v === true || v === 'true' ? true : undefined);
const DAYS = new Set<number>(RANGES.map((r) => r.days));

export const Route = createFileRoute('/news')({
  validateSearch: (s: Record<string, unknown>): NewsSearch => {
    const days = typeof s.days === 'number' ? s.days : typeof s.days === 'string' ? Number(s.days) : NaN;
    return {
      area: oneOf<NewsArea>(AREA_LABEL, s.area),
      kind: oneOf<NewsKind>(KIND_META, s.kind),
      // Definition keys and tags have the contract's shapes; anything else is dropped rather than sent.
      feed:
        typeof s.feed === 'string' &&
        /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(s.feed) &&
        s.feed.length <= 120
          ? s.feed
          : undefined,
      tag:
        typeof s.tag === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.tag) && s.tag.length <= 32
          ? s.tag
          : undefined,
      q: typeof s.q === 'string' && s.q.trim() && s.q.length <= 200 ? s.q : undefined,
      days: DAYS.has(days) && days !== DEFAULT_DAYS ? (days as RangeDays) : undefined,
      breaking: flag(s.breaking),
      unread: flag(s.unread),
      item: typeof s.item === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.item) ? s.item : undefined,
    };
  },
  component: function NewsRoute() {
    return <NewsPage search={Route.useSearch()} />;
  },
});
