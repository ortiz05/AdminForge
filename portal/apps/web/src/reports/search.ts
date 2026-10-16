import type { ReportFilters, ScheduledFilter } from './catalog';

/**
 * URL state of /reports (validated in routes/reports.tsx). Lists (`area`, `tag`) are comma-separated, and a repeated
 * parameter (`?tag=a&tag=b`) is read the same way, so links stay short and readable.
 */
export interface ReportsSearch {
  /** Report open in the details panel. */
  report?: string;
  q?: string;
  area?: string;
  tag?: string;
  scheduled?: ScheduledFilter;
  /** The schedule form: `new`, or editing the schedule in `edit`. */
  schedule?: 'new';
  edit?: string;
}

/** Definition and schedule keys: `identity.inactive-users`, `portal.identity-inactive-users-3f9a2c`. */
const KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const key = (v: unknown) => (typeof v === 'string' && v.length <= 120 && KEY.test(v) ? v : undefined);

function list(v: unknown): string | undefined {
  const raw = Array.isArray(v)
    ? v
    : typeof v === 'string' || typeof v === 'number'
      ? String(v).split(',')
      : [];
  const items = [
    ...new Set(
      raw
        .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim().toLowerCase() : ''))
        .filter((x) => x.length <= 40 && WORD.test(x)),
    ),
  ].slice(0, 20);
  return items.length ? items.join(',') : undefined;
}

export function validateReportsSearch(s: Record<string, unknown>): ReportsSearch {
  const q = typeof s.q === 'string' || typeof s.q === 'number' ? String(s.q) : undefined;
  return {
    report: key(s.report),
    q: q && q.trim() && q.length <= 200 ? q : undefined,
    area: list(s.area),
    tag: list(s.tag),
    scheduled: s.scheduled === 'yes' || s.scheduled === 'no' ? s.scheduled : undefined,
    schedule: s.schedule === 'new' ? 'new' : undefined,
    edit: key(s.edit),
  };
}

export const splitList = (v: string | undefined): string[] => (v ? v.split(',').filter(Boolean) : []);
export const joinList = (items: readonly string[]): string | undefined =>
  items.length ? [...new Set(items)].join(',') : undefined;

export function filtersOf(search: ReportsSearch): ReportFilters {
  return {
    q: search.q,
    areas: splitList(search.area),
    tags: splitList(search.tag),
    scheduled: search.scheduled,
  };
}
