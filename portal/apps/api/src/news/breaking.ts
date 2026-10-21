import type { NewsItemRow } from './types';

/**
 * "Breaking" is decided at read time so it expires on its own (docs/plans/2026-10-15-news-and-changes.md):
 * - an incident that isn't resolved, with activity in the last 14 days (one whose resolution was never seen stops
 *   counting after two quiet weeks);
 * - a critical/high security item with activity in the last 7 days;
 * - a critical/high advisory, change or retirement with activity in the last 3 days;
 * - anything whose action-required date falls within the next 14 days, with activity in the last 14 days;
 * - planned maintenance (not resolved) starting within the next 3 days.
 * The SQLite store applies the same rules in SQL (sqlite-store.ts `breakingSql`); tests hold both to this one.
 */

export const DAY_MS = 86_400_000;
export const BREAKING = {
  incidentDays: 14,
  securityDays: 7,
  urgentDays: 3,
  actionWindowDays: 14,
  maintenanceDays: 3,
} as const;

const URGENT = new Set(['critical', 'high']);
const URGENT_KINDS = new Set(['advisory', 'change', 'retirement']);

export function isBreaking(
  item: Pick<NewsItemRow, 'kind' | 'severity' | 'status' | 'activityAt' | 'actionRequiredBy'>,
  now: Date,
): boolean {
  const t = now.getTime();
  const within = (d: Date, days: number) => t - d.getTime() <= days * DAY_MS;
  const resolved = item.status === 'resolved';
  if (item.kind === 'incident' && !resolved && within(item.activityAt, BREAKING.incidentDays)) return true;
  if (item.kind === 'security' && URGENT.has(item.severity) && within(item.activityAt, BREAKING.securityDays))
    return true;
  if (
    URGENT_KINDS.has(item.kind) &&
    URGENT.has(item.severity) &&
    within(item.activityAt, BREAKING.urgentDays)
  )
    return true;
  const due = item.actionRequiredBy?.getTime();
  if (due !== undefined) {
    if (
      due >= t &&
      due <= t + BREAKING.actionWindowDays * DAY_MS &&
      within(item.activityAt, BREAKING.actionWindowDays)
    )
      return true;
    if (item.kind === 'maintenance' && !resolved && due >= t && due <= t + BREAKING.maintenanceDays * DAY_MS)
      return true;
  }
  return false;
}
