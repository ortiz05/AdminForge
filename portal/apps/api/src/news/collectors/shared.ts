import type { Feed, FeedCollector } from '@adminforge/schemas';
import type { ExecutionIdentity, OutboundExecutor } from '../../execution/types';
import type { FeedFetchResult } from '../fetch-feed';
import { factValue } from '../text';
import type { CollectResult, FeedState, NewsFact } from '../types';

/** What every collector gets. Tenant collectors call Microsoft through `outbound` as the automation identity. */
export interface CollectorDeps {
  outbound: OutboundExecutor;
  /** Public feeds (fetch-feed.ts rules, bound to this process's fetch). */
  fetchFeed: (
    url: string,
    opts: { etag?: string | null; lastModified?: string | null; signal?: AbortSignal },
  ) => Promise<FeedFetchResult>;
  now: () => Date;
}

export interface CollectContext<C extends FeedCollector = FeedCollector> {
  feedKey: string;
  feed: Feed & { collector: C };
  /** The previous run's state; null on the first run or when the definition changed (collect everything again). */
  state: FeedState | null;
  signal: AbortSignal;
  correlationId?: string;
}

export type Collector<C extends FeedCollector> = (
  ctx: CollectContext<C>,
  deps: CollectorDeps,
) => Promise<CollectResult>;

export const AUTOMATION_READ: ExecutionIdentity = { kind: 'automation', mode: 'read' };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Oldest change to ask a tenant source for: the last successful run minus an hour of overlap (late writes), never
 * further back than `lookbackDays`.
 */
export function since(state: FeedState | null, lookbackDays: number, now: Date): Date {
  const floor = now.getTime() - lookbackDays * DAY_MS;
  const last = state?.lastSuccessAt ? state.lastSuccessAt.getTime() - HOUR_MS : floor;
  return new Date(Math.max(floor, last));
}

/** OData DateTimeOffset literal (second precision, UTC). */
export const odataDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** ISO string or epoch milliseconds (number or numeric string) → Date; null when missing, invalid or before 1990. */
export function isoDate(v: unknown): Date | null {
  let t: number;
  if (typeof v === 'number') t = v;
  else if (typeof v === 'string' && /^\d{11,14}$/.test(v.trim())) t = Number(v.trim());
  else if (typeof v === 'string' && v) t = Date.parse(v);
  else return null;
  return Number.isFinite(t) && new Date(t).getUTCFullYear() >= 1990 ? new Date(t) : null;
}

export const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
export const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim())
    : [];

/** "restoringService" → "Restoring service". */
export function humanize(v: string): string {
  const words = v
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

/** Up to 12 facts with non-empty values, each at most 200 characters. */
export function facts(pairs: Array<[string, string | null | undefined]>): NewsFact[] {
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === 'string' && p[1].trim() !== '')
    .slice(0, 12)
    .map(([label, value]) => ({ label, value: factValue(value) }));
}

/** yyyy-mm-dd (UTC) for fact values. */
export const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Reads a Graph service-announcement list (messages, issues) changed since `from`. `$filter=lastModifiedDateTime ge`
 * isn't documented with an example: if Graph rejects the filter (400), read once without it and filter here — the
 * result carries a note for the feed's status instead of failing.
 */
export async function graphChangedSince(
  ctx: CollectContext,
  deps: CollectorDeps,
  call: { path: string; select?: string; maxItems: number },
  from: Date,
): Promise<{ value: Array<Record<string, unknown>>; note?: string }> {
  const read = (filtered: boolean) =>
    deps.outbound.execute<{ value?: Array<Record<string, unknown>> }>(
      AUTOMATION_READ,
      {
        service: 'graph',
        method: 'GET',
        path: call.path,
        query: {
          ...(filtered ? { $filter: `lastModifiedDateTime ge ${odataDate(from)}` } : {}),
          ...(call.select ? { $select: call.select } : {}),
          $top: 100,
        },
        paging: 'all',
        maxItems: call.maxItems,
        pathTemplate: call.path,
        ...(ctx.feed.requires ? { requires: ctx.feed.requires } : {}),
      },
      { signal: ctx.signal, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}) },
    );
  try {
    const res = await read(true);
    return { value: Array.isArray(res.data?.value) ? res.data.value : [] };
  } catch (err) {
    if ((err as { status?: unknown }).status !== 400) throw err;
    const res = await read(false);
    const all = Array.isArray(res.data?.value) ? res.data.value : [];
    return {
      value: all.filter((v) => (isoDate(v.lastModifiedDateTime)?.getTime() ?? 0) >= from.getTime()),
      note: 'Microsoft Graph did not accept the change filter, so every item was read and filtered by AdminForge.',
    };
  }
}

/** Case-insensitive equality (Graph enum values may come camelCase or PascalCase). */
export const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
