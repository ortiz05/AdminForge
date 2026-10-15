import { queryOptions } from '@tanstack/react-query';
import type { PageLike } from '@adminforge/schemas';
import type { Provenance } from '@adminforge/ui';
import type { FeatureState, ProbeSummary, WidgetError } from '@adminforge/widgets';
import { api, ApiRequestError, isRecord } from '../lib/api';
import { probesQuery, type ProbeItem } from '../ops/schedules';

/**
 * The renderer's BFF calls (contracts in @adminforge/schemas api-content.ts):
 *   GET   /api/definitions/:kind/:key           → client-safe definition + version + sha256
 *   POST  /api/datasources/execute-many         → { results: { [ds]: { data, cursor?, provenance } | { error } } }
 *   POST  /api/datasources/execute              → { data, cursor?, provenance }       (next page)
 *   GET/POST/PATCH/DELETE /api/views            → saved views ({ items } on GET)
 *   POST  /api/reports/:key/export              → file stream
 *   GET   /api/me/capabilities                  → { features: { [key]: { available, reason?, sku? } }, roles }
 */

export type PageKind = 'page' | 'dashboard' | 'report';
/** A published page, dashboard or report as the browser receives it. */
export type PageDefinition = PageLike & { version: string; sha256?: string };

const KINDS: PageKind[] = ['page', 'dashboard', 'report'];

function readDefinition(input: unknown): PageDefinition {
  const body =
    isRecord(input) && isRecord(input.definition)
      ? { ...input.definition, version: input.version ?? input.definition.version }
      : input;
  if (
    !isRecord(body) ||
    typeof body.id !== 'string' ||
    typeof body.kind !== 'string' ||
    typeof body.version !== 'string'
  )
    throw new TypeError('Expected a definition with kind, id and version');
  if (!KINDS.includes(body.kind as PageKind))
    throw new TypeError(`Expected a page, dashboard or report, got ${String(body.kind)}`);
  return body as unknown as PageDefinition;
}

const notFound = (e: unknown) => e instanceof ApiRequestError && e.status === 404;

/** Content keys don't say their kind: try page, then dashboard and report. */
export async function fetchDefinition(key: string, signal?: AbortSignal): Promise<PageDefinition> {
  const path = (kind: PageKind) => `/api/definitions/${kind}/${encodeURIComponent(key)}`;
  try {
    return await api(path('page'), { schema: { parse: readDefinition }, signal });
  } catch (e) {
    if (!notFound(e)) throw e;
  }
  const settled = await Promise.allSettled(
    (['dashboard', 'report'] as const).map((k) =>
      api(path(k), { schema: { parse: readDefinition }, signal }),
    ),
  );
  const hit = settled.find((s) => s.status === 'fulfilled');
  if (hit) return (hit as PromiseFulfilledResult<PageDefinition>).value;
  const real = settled.find((s) => s.status === 'rejected' && !notFound(s.reason));
  if (real) throw (real as PromiseRejectedResult).reason;
  throw new ApiRequestError(
    404,
    'definition_not_found',
    `There is no page, dashboard or report called “${key}”.`,
    'Check the link, or find the page with the command palette.',
  );
}

export const definitionQuery = (key: string) =>
  queryOptions({
    queryKey: ['definition', key] as const,
    queryFn: ({ signal }) => fetchDefinition(key, signal),
    staleTime: 60_000,
  });

// ── Datasources ─────────────────────────────────────────────────────────────────────────────────────

/** One datasource's first page (or its failure) as the renderer keeps it. */
export interface DatasourceOutcome {
  data: unknown;
  cursor?: string;
  provenance: Provenance | null;
  error?: WidgetError;
  /** graphBatch sub-requests that failed. */
  partial?: Record<string, WidgetError>;
  skipped?: boolean;
}

function readOutcome(raw: unknown): DatasourceOutcome {
  if (!isRecord(raw))
    return { data: null, provenance: null, error: { message: 'The data source returned nothing.' } };
  if (isRecord(raw.error))
    return {
      data: null,
      provenance: null,
      error: {
        code: typeof raw.error.code === 'string' ? raw.error.code : undefined,
        message: typeof raw.error.message === 'string' ? raw.error.message : 'The data source failed.',
        hint: typeof raw.error.hint === 'string' ? raw.error.hint : undefined,
        correlationId: typeof raw.error.correlationId === 'string' ? raw.error.correlationId : undefined,
      },
    };
  return {
    data: raw.data ?? null,
    ...(typeof raw.cursor === 'string' && raw.cursor ? { cursor: raw.cursor } : {}),
    provenance: isRecord(raw.provenance) ? (raw.provenance as unknown as Provenance) : null,
    ...(isRecord(raw.errors) ? { partial: raw.errors as Record<string, WidgetError> } : {}),
    ...(raw.skipped ? { skipped: true } : {}),
  };
}

interface Pending {
  resolve: (v: DatasourceOutcome) => void;
  reject: (e: unknown) => void;
}

/**
 * Batches datasource loads that start in the same tick into one execute-many call — widgets ask per datasource
 * (so each is cached and refreshed on its own) while the page still makes a single round trip.
 */
const batches = new Map<
  string,
  { page: string; version: string; params: Record<string, unknown>; pending: Map<string, Pending[]> }
>();

export function loadDatasource(
  page: string,
  version: string,
  params: Record<string, unknown>,
  datasource: string,
): Promise<DatasourceOutcome> {
  const key = `${page}\u0000${version}\u0000${JSON.stringify(params)}`;
  let batch = batches.get(key);
  if (!batch) {
    batch = { page, version, params, pending: new Map() };
    batches.set(key, batch);
    queueMicrotask(() => void flush(key));
  }
  const waiters = batch.pending.get(datasource) ?? [];
  batch.pending.set(datasource, waiters);
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

async function flush(key: string) {
  const batch = batches.get(key);
  batches.delete(key);
  if (!batch) return;
  const names = [...batch.pending.keys()];
  try {
    const res = await api<{ results?: Record<string, unknown> }>('/api/datasources/execute-many', {
      method: 'POST',
      body: { page: batch.page, version: batch.version, datasources: names, params: batch.params },
    });
    for (const name of names) {
      const outcome =
        res.results && name in res.results
          ? readOutcome(res.results[name])
          : {
              data: null,
              provenance: null,
              error: { code: 'missing_result', message: `The server returned no result for “${name}”.` },
            };
      for (const w of batch.pending.get(name)!) w.resolve(outcome);
    }
  } catch (e) {
    for (const ws of batch.pending.values()) for (const w of ws) w.reject(e);
  }
}

/** Next page of a `paging: cursor` datasource. */
export async function loadNextPage(
  page: string,
  version: string,
  params: Record<string, unknown>,
  datasource: string,
  cursor: string,
): Promise<DatasourceOutcome> {
  const res = await api('/api/datasources/execute', {
    method: 'POST',
    body: { page, version, datasource, params, cursor },
  });
  return readOutcome(res);
}

/** ApiRequestError → the widgets' error shape. */
export function toWidgetError(e: unknown): WidgetError {
  if (e instanceof ApiRequestError)
    return { code: e.code, message: e.message, hint: e.hint, correlationId: e.correlationId };
  return {
    message: 'AdminForge couldn’t load this data. Try again; if it keeps happening, reload the page.',
  };
}

// ── Capabilities ────────────────────────────────────────────────────────────────────────────────────

export interface Capabilities {
  features: Record<string, FeatureState & { servicePlans?: string[] }>;
}

function readCapabilities(raw: unknown): Capabilities {
  const features: Capabilities['features'] = {};
  const src = isRecord(raw) && isRecord(raw.features) ? raw.features : {};
  for (const [key, f] of Object.entries(src)) {
    if (!isRecord(f)) continue;
    // `available` (contract) or `enabled` (null = licences unreadable).
    const available =
      typeof f.available === 'boolean' ? f.available : typeof f.enabled === 'boolean' ? f.enabled : null;
    features[key] = {
      available,
      label: typeof f.label === 'string' ? f.label : key,
      ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
      ...(typeof f.sku === 'string'
        ? { sku: f.sku }
        : typeof f.requires === 'string'
          ? { sku: f.requires }
          : {}),
      ...(Array.isArray(f.servicePlans)
        ? { servicePlans: f.servicePlans.filter((p): p is string => typeof p === 'string') }
        : {}),
    };
  }
  return { features };
}

export const capabilitiesQuery = queryOptions({
  queryKey: ['capabilities'] as const,
  queryFn: ({ signal }) => api('/api/me/capabilities', { schema: { parse: readCapabilities }, signal }),
  staleTime: 5 * 60_000,
  retry: false,
});

/** Feature key for a `requires.licences` entry: a feature key (`intune`) or a service plan / SKU (`INTUNE_A`). */
export function featureKeyFor(licence: string, caps: Capabilities | undefined): string | undefined {
  if (!caps) return undefined;
  if (caps.features[licence]) return licence;
  const lower = licence.toLowerCase();
  for (const [key, f] of Object.entries(caps.features)) {
    if (key.toLowerCase() === lower) return key;
    if (f.servicePlans?.some((p) => p.toLowerCase() === lower)) return key;
  }
  return undefined;
}

// ── Probes (shared with the monitoring page's query) ────────────────────────────────────────────────

export function toProbeSummary(p: ProbeItem): ProbeSummary {
  return {
    key: p.key,
    title: p.title,
    status: p.latest?.status ?? 'unknown',
    metric: p.latest?.metric ?? null,
    unit: p.latest?.unit ?? p.thresholds.unit ?? undefined,
    message: p.latest?.message ?? null,
    lastRunAt: p.latest?.ts ?? null,
    history: p.series.map((s) => ({ ts: s.ts, status: s.status, metric: s.metric })),
  };
}

export { probesQuery };

// ── Saved views ─────────────────────────────────────────────────────────────────────────────────────

export interface SavedViewItem {
  id: string;
  name: string;
  state: Record<string, unknown>;
  shared: boolean;
  owner: string;
  mine: boolean;
}

function readViews(raw: unknown): SavedViewItem[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.items)
      ? raw.items
      : isRecord(raw) && Array.isArray(raw.views)
        ? raw.views
        : [];
  return list.filter(isRecord).map((v) => ({
    id: String(v.id),
    name: String(v.name ?? 'Untitled view'),
    state: isRecord(v.state) ? v.state : {},
    shared: Boolean(v.shared),
    owner: String(v.owner ?? ''),
    mine: typeof v.mine === 'boolean' ? v.mine : true,
  }));
}

export const viewsQuery = (page: string) =>
  queryOptions({
    queryKey: ['views', page] as const,
    queryFn: ({ signal }) =>
      api(`/api/views?page=${encodeURIComponent(page)}`, { schema: { parse: readViews }, signal }),
    staleTime: 60_000,
  });

const readView = (raw: unknown) => readViews([raw])[0]!;

export const createView = (
  page: string,
  body: { name: string; state: Record<string, unknown>; shared: boolean },
) => api('/api/views', { method: 'POST', body: { page, ...body }, schema: { parse: readView } });

export const updateView = (
  id: string,
  body: Partial<{ name: string; state: Record<string, unknown>; shared: boolean }>,
) => api(`/api/views/${encodeURIComponent(id)}`, { method: 'PATCH', body, schema: { parse: readView } });

export const deleteView = (id: string) => api(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
