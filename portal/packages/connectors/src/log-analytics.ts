import { ApiError, createHttpClient, type HttpClientOptions } from './http';

export interface LogAnalyticsQuery {
  /** Workspace (customer) id. */
  workspace: string;
  query: string;
  /** ISO 8601 duration or interval, e.g. `PT1H`, `P7D`, `2026-01-01T00:00:00Z/2026-01-02T00:00:00Z`. */
  timespan?: string;
}

export interface LogAnalyticsColumn {
  name: string;
  type: string;
}

export interface LogAnalyticsTable {
  name: string;
  columns: LogAnalyticsColumn[];
  rows: Record<string, unknown>[];
}

export interface LogAnalyticsResult {
  tables: LogAnalyticsTable[];
  /** Rows of the first (primary) table. */
  rows: Record<string, unknown>[];
  /** Set when the service returned results with a PartialError. */
  partialError?: { code: string; message: string };
  status: number;
  requestId?: string;
  ms: number;
}

export type LogAnalyticsClientOptions = Omit<HttpClientOptions, 'correlationHeader' | 'requestIdHeader'> & {
  baseUrl?: string;
};

export const LOG_ANALYTICS_BASE_URL = 'https://api.loganalytics.io';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function convert(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'dynamic':
      if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'bool':
    case 'boolean':
      return typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value);
    case 'int':
    case 'long':
    case 'real':
    case 'decimal':
      return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : value;
    default:
      return value;
  }
}

/** Converts Log Analytics `{ columns, rows: [[…]] }` tables into row objects with typed values. */
export function tablesToRows(
  tables: Array<{ name?: string; columns?: LogAnalyticsColumn[]; rows?: unknown[][] }> | undefined,
): LogAnalyticsTable[] {
  return (tables ?? []).map((t, i) => {
    const columns = t.columns ?? [];
    return {
      name: t.name ?? (i === 0 ? 'PrimaryResult' : `Table_${i}`),
      columns,
      rows: (t.rows ?? []).map((row) =>
        Object.fromEntries(columns.map((c, j) => [c.name, convert(row[j], c.type)])),
      ),
    };
  });
}

/** Log Analytics query API (`POST /v1/workspaces/{id}/query`). */
export function createLogAnalyticsClient(opts: LogAnalyticsClientOptions) {
  const base = (opts.baseUrl ?? LOG_ANALYTICS_BASE_URL).replace(/\/+$/, '');
  const http = createHttpClient({
    ...opts,
    correlationHeader: 'x-ms-client-request-id',
    requestIdHeader: 'x-ms-request-id',
  });

  async function query(q: LogAnalyticsQuery): Promise<LogAnalyticsResult> {
    if (!GUID.test(q.workspace))
      throw new Error(`Log Analytics workspace must be a workspace id (GUID), got "${q.workspace}".`);
    if (!q.query || !q.query.trim()) throw new Error('Log Analytics query is empty.');
    const r = await http.send<{
      tables?: Array<{ name?: string; columns?: LogAnalyticsColumn[]; rows?: unknown[][] }>;
      error?: { code?: string; message?: string };
    }>({
      method: 'POST',
      url: `${base}/v1/workspaces/${q.workspace.toLowerCase()}/query`,
      body: { query: q.query, ...(q.timespan ? { timespan: q.timespan } : {}) },
      idempotent: true,
    });
    if (!r.data || !Array.isArray(r.data.tables)) {
      const e = r.data?.error;
      throw new ApiError(
        r.status,
        e?.code ?? 'InvalidResponse',
        e?.message ?? 'Log Analytics returned no tables.',
        r.requestId,
      );
    }
    const tables = tablesToRows(r.data.tables);
    const e = r.data.error;
    return {
      tables,
      rows: tables[0]?.rows ?? [],
      ...(e
        ? {
            partialError: {
              code: e.code ?? 'PartialError',
              message: e.message ?? 'Some results are missing.',
            },
          }
        : {}),
      status: r.status,
      requestId: r.requestId,
      ms: r.ms,
    };
  }

  return { query };
}
export type LogAnalyticsClient = ReturnType<typeof createLogAnalyticsClient>;
