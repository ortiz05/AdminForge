import type { NewsArea, NewsItemDto, NewsKind, NewsSeverity } from '@adminforge/schemas';
import type { BadgeProps, StatusTone } from '@adminforge/ui';

/**
 * News and changes — labels, tones and date helpers shared by the page, the navigation badge and the top-bar pill.
 * Types only from @adminforge/schemas (no zod in the shell bundle); the label maps are `Record`s over the contract's
 * unions, so a new area or kind fails the type check until it has a label here.
 */

export type NewsItem = NewsItemDto;

export const AREA_LABEL: Record<NewsArea, string> = {
  identity: 'Identity',
  m365: 'Microsoft 365',
  endpoint: 'Endpoint',
  security: 'Security',
  azure: 'Azure',
  platform: 'Platform',
};
export const AREAS = Object.keys(AREA_LABEL) as NewsArea[];

type BadgeTone = NonNullable<BadgeProps['tone']>;

export const KIND_META: Record<NewsKind, { label: string; plural: string; tone: BadgeTone }> = {
  incident: { label: 'Incident', plural: 'Incidents', tone: 'crit' },
  advisory: { label: 'Advisory', plural: 'Advisories', tone: 'warn' },
  maintenance: { label: 'Maintenance', plural: 'Maintenance', tone: 'accent' },
  security: { label: 'Security', plural: 'Security', tone: 'crit' },
  change: { label: 'Change', plural: 'Changes', tone: 'accent' },
  retirement: { label: 'Retirement', plural: 'Retirements', tone: 'warn' },
  feature: { label: 'New feature', plural: 'New features', tone: 'ok' },
  preview: { label: 'Preview', plural: 'Previews', tone: 'neutral' },
  release: { label: 'Release', plural: 'Releases', tone: 'neutral' },
  info: { label: 'Info', plural: 'Info', tone: 'neutral' },
};
export const KINDS = Object.keys(KIND_META) as NewsKind[];

/** Only critical and high are called out; normal and low read as the default. */
export const SEVERITY_META: Record<NewsSeverity, { label: string; tone: StatusTone } | null> = {
  critical: { label: 'Critical', tone: 'crit' },
  high: { label: 'High', tone: 'warn' },
  normal: null,
  low: null,
};

/** Time ranges offered on the page (the API accepts 1–730 days). */
export const RANGES = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 d' },
  { days: 30, label: '30 d' },
  { days: 90, label: '90 d' },
] as const;
export type RangeDays = (typeof RANGES)[number]['days'];
export const DEFAULT_DAYS: RangeDays = 30;

const DAY_MS = 86_400_000;

/** The date an item belongs to in the feed: the source's own last activity. */
export const activityOf = (item: Pick<NewsItem, 'updatedAt' | 'publishedAt'>) =>
  item.updatedAt ?? item.publishedAt;

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", else "Mon 13 Oct" (local time). */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const day = startOfDay(Date.parse(iso));
  const today = startOfDay(now);
  if (day === today) return 'Today';
  // The day holding the instant before midnight (a day is 23 or 25 hours across a clock change).
  if (day === startOfDay(today - 1)) return 'Yesterday';
  const d = new Date(day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Items (already newest first) grouped by local day of their activity, keeping the order. */
export function groupByDay<T extends Pick<NewsItem, 'updatedAt' | 'publishedAt'>>(
  items: readonly T[],
  now: number = Date.now(),
): Array<{ key: string; label: string; items: T[] }> {
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    const iso = activityOf(item);
    const t = Date.parse(iso);
    const key = Number.isNaN(t) ? 'unknown' : String(startOfDay(t));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else
      groups.push({
        key,
        label: Number.isNaN(t) ? 'Undated' : dayLabel(iso, now),
        items: [item],
      });
  }
  return groups;
}

/** "31 Oct 2026" (local). */
export function formatDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "14:02" (local). */
export function formatClock(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export type Deadline = { state: 'soon' | 'later' | 'past'; days: number };

/** How close "action required by" is: soon (within 14 days), later, or past. */
export function deadlineOf(iso: string | null, now: number = Date.now()): Deadline | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.ceil((t - now) / DAY_MS);
  if (t < now) return { state: 'past', days };
  return { state: days <= 14 ? 'soon' : 'later', days };
}

/** The source changed the item after first publishing it (or AdminForge saw a content change). */
export function wasUpdated(item: Pick<NewsItem, 'publishedAt' | 'updatedAt' | 'firstSeenAt' | 'changedAt'>) {
  const published = Date.parse(item.publishedAt);
  const updated = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
  if (!Number.isNaN(updated) && !Number.isNaN(published) && updated - published > 60_000) return true;
  const first = Date.parse(item.firstSeenAt);
  const changed = Date.parse(item.changedAt);
  return !Number.isNaN(first) && !Number.isNaN(changed) && changed - first > 60_000;
}

/** "99+" above 99. */
export const countText = (n: number) => (n > 99 ? '99+' : String(n));

/** Tone of the breaking strip: crit when an incident, a security item or anything critical is in it. */
export function breakingTone(items: readonly Pick<NewsItem, 'kind' | 'severity'>[]): 'crit' | 'warn' {
  return items.some((i) => i.kind === 'incident' || i.kind === 'security' || i.severity === 'critical')
    ? 'crit'
    : 'warn';
}
