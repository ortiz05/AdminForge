import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getPath, splitDataRef, type WidgetData, type WidgetError } from '@adminforge/widgets';
import { loadDatasource, loadNextPage, toWidgetError, type DatasourceOutcome, type PageDefinition } from './api';

interface ExtraPages {
  /** dataUpdatedAt of the first page these follow (a refresh starts over). */
  basedOn: number;
  pages: unknown[];
  cursor?: string;
  loading: boolean;
  error?: WidgetError;
}

export interface PageData {
  /** WidgetData for a `data` reference (`users.value`). Stable while nothing changes. */
  resolve: (ref: string) => WidgetData;
  /** Raw value of a datasource path (KPI delta/trend, expression scope). */
  value: (ref: string) => unknown;
  /** Datasource name → its (merged) data, for the expression scope. */
  scopeData: Record<string, unknown>;
  refresh: () => void;
  fetching: boolean;
  updatedAt: number;
  /** All needed datasources have answered (data or error). */
  settled: boolean;
}

const stable = (v: unknown) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

/** Concatenates array values at `path` across loaded pages (cursor paging); otherwise the first page's value. */
function merged(pages: unknown[], path: string): unknown {
  const first = getPath(pages[0], path);
  if (pages.length === 1 || !Array.isArray(first)) return first;
  const out: unknown[] = [...first];
  for (const p of pages.slice(1)) {
    const v = getPath(p, path);
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

const IDLE: WidgetData = { status: 'idle', value: undefined };

/**
 * Loads a page's datasources. Each datasource is its own cached query, but loads that start together go to the BFF
 * as one execute-many call; `paging: cursor` datasources load further pages with execute. `refresh` re-runs them
 * all; `def.refresh` (seconds) does so on a timer while the tab is visible.
 */
export function usePageData(def: PageDefinition, send: Record<string, unknown>, needed: readonly string[], enabled: boolean): PageData {
  const queryClient = useQueryClient();
  const paramsKey = stable(send);
  // `send` is recreated per render; queries are keyed (and requested) by its content.
  const queries = useQueries({
    queries: needed.map((ds) => ({
      queryKey: ['ds', def.id, def.version, ds, paramsKey] as const,
      queryFn: () => loadDatasource(def.id, def.version, JSON.parse(paramsKey) as Record<string, unknown>, ds),
      enabled,
      staleTime: 30_000,
    })),
  });

  const [extra, setExtra] = useState<Record<string, ExtraPages>>({});

  const stateKey = queries.map((q) => `${q.status}:${q.dataUpdatedAt}:${q.errorUpdatedAt}`).join('|');
  const neededKey = needed.join(',');
  const extraKey = paramsKey;
  // Extra pages belong to one params set.
  const [extraFor, setExtraFor] = useState(extraKey);
  if (extraFor !== extraKey) {
    setExtraFor(extraKey);
    setExtra({});
  }

  const refetch = useCallback(
    (ds?: string) => {
      void queryClient.invalidateQueries({ queryKey: ds ? ['ds', def.id, def.version, ds] : ['ds', def.id, def.version] });
    },
    [queryClient, def.id, def.version],
  );

  const loadMore = useCallback(
    (ds: string, first: DatasourceOutcome, basedOn: number) => {
      const current = extra[ds];
      const live = current && current.basedOn === basedOn ? current : undefined;
      if (live?.loading) return;
      const cursor = live ? live.cursor : first.cursor;
      if (!cursor) return;
      setExtra((e) => ({ ...e, [ds]: { basedOn, pages: live?.pages ?? [], cursor, loading: true } }));
      loadNextPage(def.id, def.version, JSON.parse(paramsKey) as Record<string, unknown>, ds, cursor).then(
        (next) =>
          setExtra((e) => {
            const prev = e[ds];
            if (!prev || prev.basedOn !== basedOn) return e;
            if (next.error) return { ...e, [ds]: { ...prev, loading: false, error: next.error } };
            return { ...e, [ds]: { basedOn, pages: [...prev.pages, next.data], cursor: next.cursor, loading: false } };
          }),
        (err: unknown) =>
          setExtra((e) => {
            const prev = e[ds];
            if (!prev || prev.basedOn !== basedOn) return e;
            return { ...e, [ds]: { ...prev, loading: false, error: toWidgetError(err) } };
          }),
      );
    },
    [extra, def.id, def.version, paramsKey],
  );

  const api = useMemo(() => {
    const byName = new Map(needed.map((ds, i) => [ds, queries[i]!]));
    const cache = new Map<string, WidgetData>();
    const scopeData: Record<string, unknown> = {};
    const pagesOf = (ds: string): unknown[] | null => {
      const q = byName.get(ds);
      if (!q?.data || q.data.error) return null;
      const more = extra[ds];
      return more && more.basedOn === q.dataUpdatedAt ? [q.data.data, ...more.pages] : [q.data.data];
    };
    for (const ds of needed) {
      const pages = pagesOf(ds);
      if (pages) scopeData[ds] = pages.length > 1 ? mergeRoot(pages) : pages[0];
    }
    const resolve = (ref: string): WidgetData => {
      const hit = cache.get(ref);
      if (hit) return hit;
      const { root, rest } = splitDataRef(ref);
      const q = byName.get(root);
      let out: WidgetData;
      if (!q) out = enabled ? { status: 'error', value: undefined, error: { code: 'unknown_datasource', message: `This page has no datasource called “${root}”.`, hint: 'Fix the widget’s `data` in the page definition.' } } : IDLE;
      else if (q.isPending) out = enabled ? { status: 'loading', value: undefined } : IDLE;
      else if (q.isError) out = { status: 'error', value: undefined, error: toWidgetError(q.error), retry: () => refetch(root) };
      else {
        const first = q.data!;
        const sub = rest.split(/[.[]/)[0] ?? '';
        if (first.error) out = { status: 'error', value: undefined, error: first.error, provenance: null, retry: () => refetch(root) };
        else if (sub && first.partial?.[sub])
          out = { status: 'error', value: undefined, error: first.partial[sub], provenance: first.provenance, retry: () => refetch(root) };
        else {
          const more = extra[root];
          const live = more && more.basedOn === q.dataUpdatedAt ? more : undefined;
          const pages = pagesOf(root)!;
          const cursor = live ? live.cursor : first.cursor;
          out = {
            status: 'ready',
            value: merged(pages, rest),
            provenance: first.provenance,
            hasMore: Boolean(cursor) && !live?.error,
            loadingMore: Boolean(live?.loading),
            loadMore: () => loadMore(root, first, q.dataUpdatedAt),
            retry: () => refetch(root),
            ...(live?.error ? { error: live.error } : {}),
          };
        }
      }
      cache.set(ref, out);
      return out;
    };
    const value = (ref: string) => {
      const { root, rest } = splitDataRef(ref);
      return getPath(scopeData[root], rest);
    };
    return { resolve, value, scopeData };
    // stateKey captures every query's status/data change; neededKey the set of datasources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, extra, neededKey, enabled, refetch, loadMore]);

  // Auto-refresh (page `refresh: <seconds>`), only while the tab is visible.
  useEffect(() => {
    if (!def.refresh || !enabled) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refetch();
    }, def.refresh * 1000);
    return () => window.clearInterval(id);
  }, [def.refresh, enabled, refetch]);

  return {
    ...api,
    refresh: () => {
      setExtra({});
      refetch();
    },
    fetching: queries.some((q) => q.isFetching),
    updatedAt: Math.max(0, ...queries.map((q) => q.dataUpdatedAt)),
    settled: queries.every((q) => !q.isPending || !enabled),
  };
}

/** `{ value: [...] }` pages merged into one object with the concatenated `value` (Graph collections). */
function mergeRoot(pages: unknown[]): unknown {
  const first = pages[0];
  if (Array.isArray(first)) return merged(pages, '');
  if (first && typeof first === 'object' && Array.isArray((first as { value?: unknown }).value))
    return { ...(first as object), value: merged(pages, 'value') };
  return first;
}
