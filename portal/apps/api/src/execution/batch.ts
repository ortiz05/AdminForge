import {
  buildUrl,
  cleanPath,
  describePath,
  hasControlChars,
  isForbiddenHeader,
} from '@adminforge/connectors';
import { isBatchPath, startsLikeBatch } from '@adminforge/schemas';
import { AppError } from '../errors';

/**
 * Graph `$batch` as the outbound executor sees it: which paths are a batch, and the body normalised into the wire
 * format the policy checks plus one item per sub-request, each of which is checked like a request of its own.
 */

export { isBatchPath, startsLikeBatch } from '@adminforge/schemas';

/**
 * A Graph path that starts like `$batch`: `/$batch` when it is one, however written (`/$Batch`, `/$batch/`,
 * `/%24batch` — Graph may route any of them to its batch endpoint, so the requests inside are checked one by one and
 * the canonical path is sent). Anything else (`/$batch;x`) is refused rather than sent as one opaque write.
 */
export function batchPath(path: string): '/$batch' {
  if (isBatchPath(path)) return '/$batch';
  throw new AppError(
    400,
    'invalid_request',
    `This request's path isn't a clean service path (${describePath(path)}).`,
  );
}

export interface BatchItem {
  id: string;
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  beta?: boolean;
}

/**
 * `$batch` bodies may use Graph's wire format (`url`) or AdminForge's request spec (`path` + `query`); both become
 * the wire format for the policy check and BatchItems for the (auto-chunked) connector call.
 */
export function normaliseBatch(
  body: unknown,
  beta: boolean | undefined,
): { wire: { requests: Array<Record<string, unknown>> }; items: BatchItem[] } {
  const requests = (body as { requests?: unknown } | undefined)?.requests;
  if (!Array.isArray(requests) || requests.length === 0)
    throw new AppError(400, 'invalid_request', '$batch needs a non-empty requests array.');
  const items: BatchItem[] = requests.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : String(i + 1);
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET';
    const headers = r.headers as Record<string, string> | undefined;
    // The headers AdminForge owns (S-02) can't be set on a sub-request either: a raw `$batch` body bypasses the
    // datasource's and the engine's own checks.
    if (headers && typeof headers === 'object' && Object.keys(headers).some(isForbiddenHeader))
      throw new AppError(
        400,
        'invalid_request',
        `$batch request ${describePath(id)} sets a request header AdminForge always sets itself.`,
        {
          hint: 'For the content author: remove the header from the request and publish the definition again.',
        },
      );
    const itemBeta = typeof r.beta === 'boolean' ? r.beta : beta;
    // The path as it will be sent (version prefix dropped, any case): a batch inside a batch is refused.
    const inner = (typeof r.url === 'string' ? r.url : typeof r.path === 'string' ? r.path : '')
      .trim()
      .replace(/^\/*(v1\.0|beta)(?=\/|$)/i, '');
    if (isBatchPath(inner.startsWith('/') ? inner : `/${inner}`) || startsLikeBatch(inner))
      throw new AppError(400, 'invalid_request', `$batch request ${describePath(id)} is a $batch itself.`);
    // Checked before parsing: the URL parser would silently drop control characters and resolve `..` segments.
    const target = typeof r.url === 'string' ? r.url : typeof r.path === 'string' ? r.path : undefined;
    if (
      target !== undefined &&
      (hasControlChars(target) || cleanPath(target.startsWith('/') ? target : `/${target}`) === undefined)
    )
      throw new AppError(
        400,
        'invalid_request',
        `$batch request ${describePath(id)} has a path that isn't a clean service path (${describePath(target)}).`,
      );
    if (typeof r.url === 'string') {
      const u = new URL(`https://graph.invalid${r.url.startsWith('/') ? '' : '/'}${r.url}`);
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams) query[k] = v;
      return {
        id,
        method,
        path: u.pathname.replace(/^\/(v1\.0|beta)(?=\/)/i, ''),
        query,
        headers,
        body: r.body,
        beta: itemBeta,
      };
    }
    if (typeof r.path !== 'string')
      throw new AppError(400, 'invalid_request', `$batch request ${id} needs a url or a path.`);
    return {
      id,
      method,
      path: r.path,
      query: r.query as BatchItem['query'],
      headers,
      body: r.body,
      beta: itemBeta,
    };
  });
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new AppError(400, 'invalid_request', '$batch request ids must be unique.');
  const wire = {
    requests: items.map((i) => {
      let url: string;
      try {
        url = buildUrl('', { path: i.path, query: i.query }).replace(/^\/(v1\.0|beta)/, '');
      } catch {
        url = i.path;
      }
      return {
        id: i.id,
        method: i.method ?? 'GET',
        url,
        ...(i.headers ? { headers: i.headers } : {}),
        ...(i.body !== undefined ? { body: i.body } : {}),
      };
    }),
  };
  return { wire, items };
}
