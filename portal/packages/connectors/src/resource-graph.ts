import { createArmClient, type ArmClientOptions } from './arm';

/** A Resource Graph KQL query across subscriptions and/or management groups. */
export interface ResourceGraphQuery {
  query: string;
  subscriptions?: string[];
  managementGroups?: string[];
  /** Rows per page (Resource Graph allows up to 1000). */
  top?: number;
  skipToken?: string;
}

export interface ResourceGraphPage<T> {
  rows: T[];
  totalRecords?: number;
  count?: number;
  resultTruncated?: boolean;
  /** Present when more rows are available. */
  skipToken?: string;
  requestId?: string;
  ms: number;
}

export const RESOURCE_GRAPH_PATH = '/providers/Microsoft.ResourceGraph/resources';
export const RESOURCE_GRAPH_API_VERSION = '2022-10-01';

interface RawResponse {
  totalRecords?: number;
  count?: number;
  resultTruncated?: string | boolean;
  $skipToken?: string;
  data?: unknown[] | { columns?: Array<{ name: string }>; rows?: unknown[][] };
}

/** Converts the table result format to row objects; object arrays pass through. */
export function resourceGraphRows<T = Record<string, unknown>>(data: RawResponse['data']): T[] {
  if (Array.isArray(data)) return data as T[];
  const columns = data?.columns ?? [];
  return (data?.rows ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c.name, row[i]])) as T);
}

export function createResourceGraphClient(opts: ArmClientOptions & { apiVersion?: string }) {
  const arm = createArmClient(opts);
  const apiVersion = opts.apiVersion ?? RESOURCE_GRAPH_API_VERSION;

  async function query<T = Record<string, unknown>>(q: ResourceGraphQuery): Promise<ResourceGraphPage<T>> {
    if (!q.query || !q.query.trim()) throw new Error('Resource Graph query is empty.');
    const body = {
      query: q.query,
      ...(q.subscriptions?.length ? { subscriptions: q.subscriptions } : {}),
      ...(q.managementGroups?.length ? { managementGroups: q.managementGroups } : {}),
      options: {
        resultFormat: 'objectArray',
        ...(q.top ? { $top: Math.min(q.top, 1000) } : {}),
        ...(q.skipToken ? { $skipToken: q.skipToken } : {}),
      },
    };
    const r = await arm.request<RawResponse>({ method: 'POST', path: RESOURCE_GRAPH_PATH, apiVersion, body });
    return {
      rows: resourceGraphRows<T>(r.data?.data),
      totalRecords: r.data?.totalRecords,
      count: r.data?.count,
      resultTruncated: r.data?.resultTruncated === true || r.data?.resultTruncated === 'true',
      skipToken: r.data?.$skipToken || undefined,
      requestId: r.requestId,
      ms: r.ms,
    };
  }

  /** Follows `$skipToken` page by page. */
  async function* pages<T = Record<string, unknown>>(q: ResourceGraphQuery, maxPages = 50): AsyncGenerator<ResourceGraphPage<T>> {
    let skipToken = q.skipToken;
    for (let i = 0; i < maxPages; i++) {
      const page: ResourceGraphPage<T> = await query<T>({ ...q, skipToken });
      yield page;
      if (!page.skipToken) return;
      skipToken = page.skipToken;
    }
  }

  async function all<T = Record<string, unknown>>(q: ResourceGraphQuery, maxItems = 5000): Promise<T[]> {
    const out: T[] = [];
    for await (const page of pages<T>(q)) {
      out.push(...page.rows);
      if (out.length >= maxItems) return out.slice(0, maxItems);
    }
    return out;
  }

  return { query, pages, all };
}
export type ResourceGraphClient = ReturnType<typeof createResourceGraphClient>;
