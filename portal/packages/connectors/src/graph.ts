import { ApiError, createHttpClient, retryDelay, type HttpClientOptions } from './http';
import { defaultSleep } from './types';

export interface GraphRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  beta?: boolean;
}

export interface GraphResult<T> {
  data: T;
  status: number;
  requestId?: string;
  ms: number;
}

export { ApiError as GraphError };

export type GraphClientOptions = Omit<HttpClientOptions, 'correlationHeader' | 'requestIdHeader'> & { baseUrl?: string };

const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

/** Rejects paths that are not rooted, or that contain dot segments (also percent-encoded) or encoded slashes. */
export function assertSafePath(path: string, label = 'Graph'): void {
  const segments = path.split('/');
  if (!path.startsWith('/') || segments.some((s) => DOT_SEGMENT.test(s)) || /%2f|%5c|\\/i.test(path)) throw new Error(`Invalid ${label} path: ${path}`);
}

/** Query string with `$` kept literal in keys and values percent-encoded (spaces as %20, never "+"). Empty values are dropped. */
export function buildQuery(query: Record<string, string | number | boolean | undefined | null> | undefined): string {
  return Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Builds a Graph URL. `$` keys stay literal; values are percent-encoded (spaces as %20, never "+"). */
export function buildUrl(base: string, req: GraphRequest): string {
  assertSafePath(req.path);
  const qs = buildQuery(req.query);
  return `${base}/${req.beta ? 'beta' : 'v1.0'}${req.path}${qs ? `?${qs}` : ''}`;
}

type BatchItem = { id: string } & GraphRequest;
type BatchResponse = { id: string; status: number; headers?: Record<string, string>; body: unknown };

const SAFE = new Set(['GET', 'HEAD']);

/** $batch returns non-JSON bodies (e.g. `$count`) base64-encoded with a text/plain content type; decode them. */
export function decodeBatchBody(r: { headers?: Record<string, string>; body: unknown }): unknown {
  const type = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (typeof r.body !== 'string' || !/^text\/plain/i.test(type)) return r.body;
  if (/^\d+$/.test(r.body.trim())) return Number(r.body);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(r.body) || r.body.length % 4 !== 0) return r.body;
  const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return /^\d+$/.test(text.trim()) ? Number(text) : text;
}

export function createGraphClient(opts: GraphClientOptions) {
  const base = opts.baseUrl ?? 'https://graph.microsoft.com';
  const sleep = opts.sleep ?? defaultSleep;
  const http = createHttpClient({ ...opts, correlationHeader: 'client-request-id', requestIdHeader: 'request-id' });

  async function request<T>(req: GraphRequest, url = buildUrl(base, req)): Promise<GraphResult<T>> {
    const isBatch = req.path === '/$batch';
    const batchIsRead = isBatch && ((req.body as { requests?: Array<{ method?: string }> })?.requests ?? []).every((r) => SAFE.has((r.method ?? 'GET').toUpperCase()));
    const r = await http.send<T>({ method: req.method, url, headers: req.headers, body: req.body, ...(isBatch ? { idempotent: batchIsRead } : {}) });
    return { data: r.data, status: r.status, requestId: r.requestId, ms: r.ms };
  }

  /** Follows @odata.nextLink; refuses links that leave Graph (SSRF guard). */
  async function* pages<T>(req: GraphRequest, maxPages = 50): AsyncGenerator<T[]> {
    let next: string | undefined = buildUrl(base, req);
    for (let i = 0; next && i < maxPages; i++) {
      const { data }: GraphResult<{ value: T[]; '@odata.nextLink'?: string }> = await request(req, next);
      yield data.value;
      next = data['@odata.nextLink'];
      if (next && !next.startsWith(`${base}/`)) throw new Error('nextLink points outside Graph; refusing to follow it.');
    }
  }

  /** Collects all pages up to maxItems. */
  async function all<T>(req: GraphRequest, maxItems = 5000): Promise<T[]> {
    const out: T[] = [];
    for await (const page of pages<T>(req)) {
      out.push(...page);
      if (out.length >= maxItems) return out.slice(0, maxItems);
    }
    return out;
  }

  const toRequest = (r: BatchItem) => ({
    id: r.id,
    method: (r.method ?? 'GET').toUpperCase(),
    url: buildUrl('', r).replace(/^\/(v1\.0|beta)/, ''),
    ...(r.body !== undefined
      ? { body: r.body, headers: { 'Content-Type': 'application/json', ...r.headers } }
      : r.headers
        ? { headers: r.headers }
        : {}),
  });

  async function sendChunk(chunk: BatchItem[], beta: boolean): Promise<BatchResponse[]> {
    const { data } = await request<{ responses: BatchResponse[] }>({ method: 'POST', path: '/$batch', beta, body: { requests: chunk.map(toRequest) } });
    return data?.responses ?? [];
  }

  /**
   * JSON $batch, auto-chunked by 20 (v1.0 and beta items go in separate batches); throttled (429) items are retried
   * once after their Retry-After.
   */
  async function batch(items: BatchItem[]): Promise<Record<string, { status: number; body: unknown }>> {
    const out: Record<string, { status: number; body: unknown }> = {};
    for (const beta of [false, true]) {
      const group = items.filter((i) => !!i.beta === beta);
      for (let i = 0; i < group.length; i += 20) {
        const chunk = group.slice(i, i + 20);
        const responses = await sendChunk(chunk, beta);
        for (const r of responses) out[r.id] = { status: r.status, body: decodeBatchBody(r) };
        const throttled = responses.filter((r) => r.status === 429);
        if (!throttled.length) continue;
        const header = (r: BatchResponse) => Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1] ?? null;
        await sleep(Math.max(...throttled.map((r) => retryDelay(header(r), 0))));
        const retry = chunk.filter((c) => throttled.some((t) => t.id === c.id));
        for (const r of await sendChunk(retry, beta)) out[r.id] = { status: r.status, body: decodeBatchBody(r) };
      }
    }
    return out;
  }

  return { request, pages, all, batch };
}
export type GraphClient = ReturnType<typeof createGraphClient>;
