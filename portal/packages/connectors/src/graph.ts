import { ApiError, createHttpClient, type HttpClientOptions } from './http';

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

/** Builds a Graph URL. `$` keys stay literal; values are percent-encoded (spaces as %20, never "+"). */
export function buildUrl(base: string, req: GraphRequest): string {
  if (!req.path.startsWith('/') || req.path.split('/').includes('..')) throw new Error(`Invalid Graph path: ${req.path}`);
  const qs = Object.entries(req.query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}/${req.beta ? 'beta' : 'v1.0'}${req.path}${qs ? `?${qs}` : ''}`;
}

export function createGraphClient(opts: GraphClientOptions) {
  const base = opts.baseUrl ?? 'https://graph.microsoft.com';
  const http = createHttpClient({ ...opts, correlationHeader: 'client-request-id', requestIdHeader: 'request-id' });

  async function request<T>(req: GraphRequest, url = buildUrl(base, req)): Promise<GraphResult<T>> {
    const r = await http.send<T>({ method: req.method, url, headers: req.headers, body: req.body });
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

  /** JSON $batch, auto-chunked by 20; per-item 429s are retried once after their Retry-After. */
  async function batch(items: Array<{ id: string } & GraphRequest>): Promise<Record<string, { status: number; body: unknown }>> {
    const out: Record<string, { status: number; body: unknown }> = {};
    const toRequest = (r: { id: string } & GraphRequest) => ({
      id: r.id,
      method: r.method ?? 'GET',
      url: buildUrl('', r).replace(/^\/(v1\.0|beta)/, ''),
      ...(r.body !== undefined
        ? { body: r.body, headers: { 'Content-Type': 'application/json', ...r.headers } }
        : r.headers
          ? { headers: r.headers }
          : {}),
    });
    for (let i = 0; i < items.length; i += 20) {
      const chunk = items.slice(i, i + 20);
      const { data } = await request<{ responses: Array<{ id: string; status: number; body: unknown }> }>({
        method: 'POST',
        path: '/$batch',
        beta: chunk.some((c) => c.beta),
        body: { requests: chunk.map(toRequest) },
      });
      for (const r of data.responses) out[r.id] = { status: r.status, body: r.body };
    }
    return out;
  }

  return { request, pages, all, batch };
}
export type GraphClient = ReturnType<typeof createGraphClient>;
