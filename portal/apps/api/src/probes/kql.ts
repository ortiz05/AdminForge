import { RESOURCE_GRAPH_API_VERSION, RESOURCE_GRAPH_PATH, type Provenance } from '@adminforge/connectors';
import type { KqlSource } from '@adminforge/schemas';
import { AppError } from '../errors';
import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';

/**
 * One KQL query against Azure Resource Graph, Log Analytics, or Defender advanced hunting (R12), through the outbound
 * executor (request policy, tokens, provenance). Used by `kql` probe checks (automation identity) and Query Studio
 * (the signed-in engineer's delegated read identity). All three are read-only POSTs the read-mode policy allows.
 */

export interface KqlRequest {
  source: KqlSource;
  query: string;
  subscriptions?: string[];
  managementGroups?: string[];
  /** Log Analytics workspace (customer) id. */
  workspace?: string;
  /** ISO 8601 duration (Log Analytics, advanced hunting). */
  timespan?: string;
  /** Rows kept (the rest is counted where the service tells, and `truncated` is set). */
  maxRows: number;
}

export interface KqlColumn {
  name: string;
  type: string;
}

export interface KqlResult {
  columns: KqlColumn[];
  rows: Record<string, unknown>[];
  /** Rows the query produced (≥ rows.length when truncated and the service reports a total). */
  totalRows: number;
  truncated: boolean;
  provenance: Provenance;
  /** Log Analytics returned partial results. */
  partialError?: { code: string; message: string };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export const workspaceNotConfigured = () =>
  new AppError(503, 'workspace_not_configured', 'No Log Analytics workspace is configured.', {
    hint: 'Set AF_LOG_ANALYTICS_WORKSPACE_ID (the workspace customer id) in the AdminForge env file, or name a workspace.',
  });

/** Column types for row objects (Resource Graph returns objects without a schema). */
export function inferColumns(rows: readonly Record<string, unknown>[]): KqlColumn[] {
  const types = new Map<string, string>();
  for (const row of rows.slice(0, 200)) {
    for (const [k, v] of Object.entries(row)) {
      if (types.get(k) && types.get(k) !== 'unknown') continue;
      if (v === null || v === undefined) {
        if (!types.has(k)) types.set(k, 'unknown');
        continue;
      }
      types.set(
        k,
        typeof v === 'number'
          ? Number.isInteger(v)
            ? 'long'
            : 'real'
          : typeof v === 'boolean'
            ? 'bool'
            : typeof v === 'string'
              ? ISO_DATE.test(v)
                ? 'datetime'
                : 'string'
              : 'dynamic',
      );
    }
  }
  return [...types].map(([name, type]) => ({ name, type: type === 'unknown' ? 'dynamic' : type }));
}

export async function runKql(
  identity: ExecutionIdentity,
  outbound: OutboundExecutor,
  req: KqlRequest,
  opts: { correlationId?: string; signal?: AbortSignal } = {},
): Promise<KqlResult> {
  if (!req.query.trim()) throw new AppError(400, 'invalid_request', 'The query is empty.');
  const max = Math.max(1, req.maxRows);
  if (req.source === 'resourceGraph') {
    const r = await outbound.execute<{ value?: Record<string, unknown>[]; totalRecords?: number }>(
      identity,
      {
        service: 'arm',
        method: 'POST',
        path: RESOURCE_GRAPH_PATH,
        apiVersion: RESOURCE_GRAPH_API_VERSION,
        body: {
          query: req.query,
          subscriptions: req.subscriptions?.length ? req.subscriptions : undefined,
          managementGroups: req.managementGroups?.length ? req.managementGroups : undefined,
        },
        paging: 'all',
        maxItems: max,
        pathTemplate: RESOURCE_GRAPH_PATH,
      },
      opts,
    );
    const rows = r.data?.value ?? [];
    const total = Math.max(r.data?.totalRecords ?? rows.length, rows.length);
    return {
      columns: inferColumns(rows),
      rows: rows.slice(0, max),
      totalRows: total,
      truncated: total > max || rows.length > max,
      provenance: r.provenance,
    };
  }
  if (req.source === 'logAnalytics') {
    const ws = req.workspace?.trim();
    if (!ws) throw workspaceNotConfigured();
    if (!GUID.test(ws))
      throw new AppError(
        400,
        'invalid_workspace',
        'The Log Analytics workspace must be its workspace (customer) id, a GUID.',
      );
    const r = await outbound.execute<{
      value?: Record<string, unknown>[];
      tables?: Array<{ columns?: KqlColumn[] }>;
      partialError?: { code: string; message: string };
    }>(
      identity,
      {
        service: 'logAnalytics',
        method: 'POST',
        path: `/v1/workspaces/${ws.toLowerCase()}/query`,
        body: { query: req.query, ...(req.timespan ? { timespan: req.timespan } : {}) },
        pathTemplate: '/v1/workspaces/{workspace}/query',
      },
      opts,
    );
    const rows = r.data?.value ?? [];
    const columns = (r.data?.tables?.[0]?.columns ?? []).map((c) => ({ name: c.name, type: c.type }));
    return {
      columns: columns.length ? columns : inferColumns(rows),
      rows: rows.slice(0, max),
      totalRows: rows.length,
      truncated: rows.length > max,
      provenance: r.provenance,
      ...(r.data?.partialError ? { partialError: r.data.partialError } : {}),
    };
  }
  const r = await outbound.execute<{
    schema?: Array<{ name?: string; Name?: string; type?: string; Type?: string }>;
    results?: Record<string, unknown>[];
  }>(
    identity,
    {
      service: 'graph',
      method: 'POST',
      path: '/security/runHuntingQuery',
      body: { Query: req.query, ...(req.timespan ? { Timespan: req.timespan } : {}) },
      pathTemplate: '/security/runHuntingQuery',
    },
    opts,
  );
  const rows = r.data?.results ?? [];
  const columns = (r.data?.schema ?? [])
    .map((c) => ({ name: String(c.name ?? c.Name ?? ''), type: String(c.type ?? c.Type ?? 'string') }))
    .filter((c) => c.name);
  return {
    columns: columns.length ? columns : inferColumns(rows),
    rows: rows.slice(0, max),
    totalRows: rows.length,
    truncated: rows.length > max,
    provenance: r.provenance,
  };
}

/** A column aggregate over numeric values; null when the column has no numbers. */
export function aggregate(
  rows: readonly Record<string, unknown>[],
  column: string,
  agg: 'max' | 'min' | 'sum' | 'avg' | 'first',
): number | null {
  const nums = rows
    .map((r) => r[column])
    .map((v) =>
      typeof v === 'number'
        ? v
        : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
          ? Number(v)
          : null,
    );
  if (agg === 'first') return nums[0] ?? null;
  const vals = nums.filter((n): n is number => n !== null);
  if (!vals.length) return agg === 'sum' ? 0 : null;
  switch (agg) {
    case 'max':
      return Math.max(...vals);
    case 'min':
      return Math.min(...vals);
    case 'sum':
      return vals.reduce((a, b) => a + b, 0);
    case 'avg':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

/** Rows as stored on probe results: capped columns and value sizes (details are for drill-down, not archives). */
export function detailRows(
  rows: readonly Record<string, unknown>[],
  limit: number,
): Record<string, unknown>[] {
  const cell = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length > 300) return `${s.slice(0, 297)}…`;
    return v;
  };
  return rows.slice(0, limit).map((r) =>
    Object.fromEntries(
      Object.entries(r)
        .slice(0, 30)
        .map(([k, v]) => [k, cell(v)]),
    ),
  );
}
