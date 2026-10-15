import { queryOptions } from '@tanstack/react-query';
import { api, isRecord, type Parser } from '../lib/api';

/**
 * Query Studio contracts (R12). Read-only by design: every call runs as the signed-in engineer in read mode.
 *
 *   POST /api/query            { source, query, subscriptions?, workspace?, timespan? }
 *                              → { columns: [{ name, type }], rows, rowCount, truncated, ms, provenance }
 *   POST /api/query/scaffold   { as, source, query, title, … } → { yaml, path }
 *   GET  /api/me/capabilities  → { features: { defender: { available, reason?, sku? } } }
 */

export const SOURCES = ['resourceGraph', 'logAnalytics', 'advancedHunting'] as const;
export type QuerySource = (typeof SOURCES)[number];
export const isSource = (v: unknown): v is QuerySource =>
  typeof v === 'string' && (SOURCES as readonly string[]).includes(v);

export interface QueryRequest {
  source: QuerySource;
  query: string;
  /** Resource Graph only; omitted = every subscription the engineer can read. */
  subscriptions?: string[];
  /** Log Analytics only; omitted = the configured default workspace (AF_LOG_ANALYTICS_WORKSPACE_ID). */
  workspace?: string;
  /** Log Analytics / advanced hunting; ISO 8601 duration. Omitted = the time filter in the query decides. */
  timespan?: string;
}

export interface ResultColumn {
  name: string;
  /** KQL type: string, int, long, real, decimal, bool, datetime, timespan, guid, dynamic. */
  type: string;
}

export interface Provenance {
  service: string;
  path: string;
  ms?: number;
  requestId?: string;
  cachedAt?: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  ms: number;
  provenance: Provenance | null;
}

const fail = (what: string): never => {
  throw new TypeError(`Expected ${what}`);
};

/** Rows may arrive as objects or as arrays aligned with `columns`; both become objects keyed by column name. */
function readRows(raw: unknown, columns: ResultColumn[]): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return fail('{ rows: [] }');
  return raw.map((r) => {
    if (Array.isArray(r)) return Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]));
    return isRecord(r) ? r : {};
  });
}

function readProvenance(raw: unknown): Provenance | null {
  if (!isRecord(raw) || typeof raw.service !== 'string') return null;
  return {
    service: raw.service,
    path: typeof raw.path === 'string' ? raw.path : '',
    ...(typeof raw.ms === 'number' ? { ms: raw.ms } : {}),
    ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId } : {}),
    ...(typeof raw.cachedAt === 'string' ? { cachedAt: raw.cachedAt } : {}),
  };
}

export const QueryResultParser: Parser<QueryResult> = {
  parse(input) {
    if (!isRecord(input)) return fail('a query result object');
    const columns = Array.isArray(input.columns)
      ? input.columns.flatMap((c): ResultColumn[] =>
          isRecord(c) && typeof c.name === 'string'
            ? [{ name: c.name, type: typeof c.type === 'string' ? c.type.toLowerCase() : 'string' }]
            : [],
        )
      : fail('{ columns: [] }');
    const rows = readRows(input.rows, columns);
    return {
      columns,
      rows,
      rowCount: typeof input.rowCount === 'number' ? input.rowCount : rows.length,
      truncated: input.truncated === true,
      ms: typeof input.ms === 'number' ? input.ms : 0,
      provenance: readProvenance(input.provenance),
    };
  },
};

export function runQuery(req: QueryRequest, signal?: AbortSignal): Promise<QueryResult> {
  return api('/api/query', { method: 'POST', body: req, schema: QueryResultParser, signal });
}

// ── Save as report / probe / schedule ─────────────────────────────────────────

export const SAVE_KINDS = ['report', 'probe', 'schedule'] as const;
export type SaveKind = (typeof SAVE_KINDS)[number];

/**
 * What is sent to the scaffold: never subscription or workspace ids — those are tenant configuration and must not
 * end up in committed content (R2). The file queries every subscription the runner can read and the configured
 * default workspace.
 */
export interface ScaffoldRequest {
  as: SaveKind;
  source: QuerySource;
  query: string;
  title: string;
  timespan?: string;
  /** Result columns of the last run of this query (report table columns). */
  columns?: ResultColumn[];
}

export interface ScaffoldResult {
  yaml: string;
  /** Repository-relative path the file belongs at, e.g. portal/content/reports/azure/untagged.report.yaml. */
  path: string;
  /** Definition id, e.g. azure.untagged (when the server says). */
  key?: string;
}

export const ScaffoldParser: Parser<ScaffoldResult> = {
  parse(input) {
    if (!isRecord(input) || typeof input.yaml !== 'string' || typeof input.path !== 'string')
      return fail('{ yaml, path }');
    return {
      yaml: input.yaml,
      path: input.path,
      ...(typeof input.key === 'string' ? { key: input.key } : {}),
    };
  },
};

export const scaffoldQuery = (req: ScaffoldRequest) =>
  api('/api/query/scaffold', { method: 'POST', body: req, schema: ScaffoldParser });

// ── Defender licence (capabilities) ───────────────────────────────────────────

export interface FeatureState {
  available: boolean;
  reason?: string;
  sku?: string;
}

/** Only the Defender feature; a separate cache entry from the playbook preflight's view of capabilities. */
export const defenderFeatureQuery = queryOptions({
  queryKey: ['capabilities', 'features', 'defender'] as const,
  queryFn: ({ signal }) =>
    api('/api/me/capabilities', {
      signal,
      schema: {
        parse(input): FeatureState | null {
          const f = isRecord(input) && isRecord(input.features) ? input.features.defender : undefined;
          if (!isRecord(f) || typeof f.available !== 'boolean') return null;
          return {
            available: f.available,
            ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
            ...(typeof f.sku === 'string' ? { sku: f.sku } : {}),
          };
        },
      },
    }),
  staleTime: 10 * 60_000,
  retry: false,
});

// ── Scope pickers, answered by Resource Graph through the same endpoint ───────

export interface ScopeOption {
  value: string;
  label: string;
  description?: string;
}

const SUBSCRIPTIONS_KQL = `resourcecontainers
| where type =~ 'microsoft.resources/subscriptions'
| project subscriptionId, name
| order by name asc`;

const WORKSPACES_KQL = `resources
| where type =~ 'microsoft.operationalinsights/workspaces'
| project name, customerId = tostring(properties.customerId), resourceGroup
| order by name asc`;

export const subscriptionsQuery = queryOptions({
  queryKey: ['query-studio', 'subscriptions'] as const,
  queryFn: async ({ signal }): Promise<ScopeOption[]> => {
    const r = await runQuery({ source: 'resourceGraph', query: SUBSCRIPTIONS_KQL }, signal);
    return r.rows.flatMap((row) =>
      typeof row.subscriptionId === 'string'
        ? [{ value: row.subscriptionId, label: typeof row.name === 'string' ? row.name : row.subscriptionId }]
        : [],
    );
  },
  staleTime: 10 * 60_000,
  retry: false,
});

export const workspacesQuery = queryOptions({
  queryKey: ['query-studio', 'workspaces'] as const,
  queryFn: async ({ signal }): Promise<ScopeOption[]> => {
    const r = await runQuery({ source: 'resourceGraph', query: WORKSPACES_KQL }, signal);
    return r.rows.flatMap((row) =>
      typeof row.customerId === 'string' && row.customerId
        ? [
            {
              value: row.customerId,
              label: typeof row.name === 'string' ? row.name : row.customerId,
              ...(typeof row.resourceGroup === 'string' ? { description: row.resourceGroup } : {}),
            },
          ]
        : [],
    );
  },
  staleTime: 10 * 60_000,
  retry: false,
});
