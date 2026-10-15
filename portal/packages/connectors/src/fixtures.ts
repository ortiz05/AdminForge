import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Fixture-backed `fetch` for DATA_MODE=fixtures (mock mode, e2e, tests). Connectors take it as their `fetch` option,
 * so the whole stack (paging, $batch, retries, errors) runs unchanged against synthetic data.
 *
 * File naming (everything lower-case):
 *
 *   <dir>/<service>/<path>/<METHOD>[__<query>].json
 *
 *   service  graph.microsoft.com                      → graph            (keeps the version: graph/v1.0/users/GET.json)
 *            management.azure.com                     → arm              (api-version is ignored)
 *              POST /providers/Microsoft.ResourceGraph/resources → resourceGraph   (no path: resourceGraph/POST.json)
 *            api.loganalytics.io / .azure.com          → logAnalytics     (path = workspace id: logAnalytics/<id>/POST.json)
 *            any other host                           → hosts/<host>
 *   path     URL path segments, percent-decoded; characters outside [a-z0-9._$@=+,-] become "_" ("." / ".." too).
 *   query    `key=value` pairs sorted by key (decoded, same character rule, api-version dropped) joined with "&";
 *            longer than 100 characters → "h" + the first 16 hex chars of sha256(joined pairs).
 *
 * Lookup: `<METHOD>__<query>.json` first, then `<METHOD>.json`. Unknown routes answer 404 JSON naming the file to create.
 *
 * File content: either the response body (status 200; numbers/strings are sent as text/plain, e.g. /users/$count), or
 *   { "$fixture": { "status": 200, "headers": {…}, "body": …,
 *                   "variants": [{ "match": { "bodyIncludes": "…" | ["…"], "query": { "k": "v" } }, "status", "headers", "body" }] } }
 * The first variant whose `match` holds wins (all `bodyIncludes` strings appear in the request body, case- and
 * whitespace-insensitive; every `query` value equals the request's); otherwise the top-level status/body apply.
 *
 * Graph `POST /$batch` without its own fixture is answered by resolving each sub-request against the files above.
 */

export interface FixtureFetchOptions {
  /** Unmatched non-GET/HEAD requests answer 204 instead of 404 (handy for mock-mode write flows). */
  acceptWrites?: boolean;
  /** Artificial latency per request. */
  delayMs?: number;
  /** Observe each request and the fixture file used (undefined = not found). */
  onRequest?: (info: { method: string; url: string; file?: string; status: number }) => void;
}

export interface FixtureKey {
  service: string;
  /** Candidate files relative to the fixtures dir, most specific first. */
  candidates: string[];
}

const QUERY_MAX = 100;

const sanitize = (s: string) => {
  const out = s.toLowerCase().replace(/[^a-z0-9._$@=+,-]/g, '_');
  return out === '.' || out === '..' ? '_' : out;
};
const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

function routeOf(url: URL, method: string): { service: string; segments: string[] } {
  const host = url.hostname.toLowerCase();
  const raw = url.pathname.split('/').filter(Boolean).map(decode);
  if (host === 'graph.microsoft.com') return { service: 'graph', segments: raw };
  if (host === 'management.azure.com') {
    if (method === 'POST' && /^\/providers\/microsoft\.resourcegraph\/resources\/?$/i.test(url.pathname))
      return { service: 'resourceGraph', segments: [] };
    return { service: 'arm', segments: raw };
  }
  if (host === 'api.loganalytics.io' || host === 'api.loganalytics.azure.com') {
    const m = /^\/v1\/workspaces\/([^/]+)\/query\/?$/i.exec(url.pathname);
    return { service: 'logAnalytics', segments: m ? [decode(m[1]!)] : raw };
  }
  return { service: `hosts/${sanitize(url.host)}`, segments: raw };
}

/** Where the fixture for a request lives (see the naming scheme above). */
export function fixtureKey(method: string, rawUrl: string): FixtureKey {
  const url = new URL(rawUrl);
  const m = method.toUpperCase();
  const { service, segments } = routeOf(url, m);
  const dir = [service, ...segments.map(sanitize)].join('/');
  const pairs = [...url.searchParams.entries()]
    .filter(([k]) => k.toLowerCase() !== 'api-version')
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${sanitize(k)}=${sanitize(v)}`)
    .join('&');
  const query =
    pairs.length > QUERY_MAX ? `h${createHash('sha256').update(pairs).digest('hex').slice(0, 16)}` : pairs;
  return { service, candidates: [...(query ? [`${dir}/${m}__${query}.json`] : []), `${dir}/${m}.json`] };
}

interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}
interface FixtureEnvelope extends FixtureResponse {
  variants?: Array<
    FixtureResponse & { match?: { bodyIncludes?: string | string[]; query?: Record<string, string> } }
  >;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

function pick(content: unknown, url: URL, bodyText: string): FixtureResponse | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content) || !('$fixture' in content))
    return { status: 200, body: content };
  const env = (content as { $fixture: FixtureEnvelope }).$fixture ?? {};
  const body = norm(bodyText);
  for (const v of env.variants ?? []) {
    const includes = v.match?.bodyIncludes === undefined ? [] : [v.match.bodyIncludes].flat();
    const queryOk = Object.entries(v.match?.query ?? {}).every(
      ([k, val]) => (url.searchParams.get(k) ?? '').toLowerCase() === String(val).toLowerCase(),
    );
    if (queryOk && includes.every((s) => body.includes(norm(s)))) return v;
  }
  if ('body' in env || env.status !== undefined) return env;
  return undefined;
}

let seq = 0;

function respond(r: FixtureResponse): Response {
  const status = r.status ?? 200;
  const text = typeof r.body === 'string' || typeof r.body === 'number';
  const nullBody = status === 204 || status === 304 || r.body === undefined;
  const id = `fixture-${++seq}`;
  return new Response(nullBody ? null : text ? String(r.body) : JSON.stringify(r.body), {
    status,
    headers: {
      'content-type': text ? 'text/plain' : 'application/json',
      'request-id': id,
      'x-ms-request-id': id,
      ...r.headers,
    },
  });
}

async function bodyText(input: string | URL | Request, init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (body === undefined || body === null) return input instanceof Request ? input.clone().text() : '';
  if (typeof body === 'string') return body;
  return new Response(body).text();
}

/** Creates a fetch-compatible responder over fixture files in `dir`. */
export function createFixtureFetch(dir: string, opts: FixtureFetchOptions = {}): typeof fetch {
  const root = path.resolve(dir);

  async function load(rel: string): Promise<unknown> {
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return undefined;
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'EISDIR'
      )
        return undefined;
      throw new Error(`Fixture ${rel} is not valid JSON: ${(err as Error).message}`, { cause: err });
    }
  }

  async function resolveRequest(
    method: string,
    url: URL,
    text: string,
  ): Promise<{ response: FixtureResponse; file?: string }> {
    const key = fixtureKey(method, url.href);
    for (const rel of key.candidates) {
      const content = await load(rel);
      if (content === undefined) continue;
      const r = pick(content, url, text);
      if (r) return { response: r, file: rel };
    }
    if (key.service === 'graph' && method === 'POST' && /\/\$batch\/?$/.test(url.pathname)) {
      const version = url.pathname.split('/').filter(Boolean)[0] ?? 'v1.0';
      const requests =
        (
          JSON.parse(text || '{}') as {
            requests?: Array<{ id: string; method?: string; url: string; body?: unknown }>;
          }
        ).requests ?? [];
      const responses = [];
      for (const sub of requests) {
        const subUrl = new URL(`${url.origin}/${version}${sub.url.startsWith('/') ? '' : '/'}${sub.url}`);
        const r = await resolveRequest(
          (sub.method ?? 'GET').toUpperCase(),
          subUrl,
          sub.body === undefined ? '' : JSON.stringify(sub.body),
        );
        const body = r.response.body;
        // Like Graph: non-JSON sub-response bodies come back base64-encoded as text/plain.
        responses.push(
          typeof body === 'number' || typeof body === 'string'
            ? {
                id: sub.id,
                status: r.response.status ?? 200,
                headers: { 'content-type': 'text/plain', ...r.response.headers },
                body: btoa(String(body)),
              }
            : {
                id: sub.id,
                status: r.response.status ?? 200,
                headers: { 'content-type': 'application/json', ...r.response.headers },
                body,
              },
        );
      }
      return { response: { status: 200, body: { responses } } };
    }
    if (opts.acceptWrites && method !== 'GET' && method !== 'HEAD') return { response: { status: 204 } };
    return {
      response: {
        status: 404,
        body: {
          error: {
            code: 'FixtureNotFound',
            message: `No fixture for ${method} ${url.href}. Create ${key.candidates.join(' or ')} in the fixtures directory.`,
          },
        },
      },
    };
  }

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const text = await bodyText(input, init);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const { response, file } = await resolveRequest(method, url, text);
    opts.onRequest?.({ method, url: url.href, file, status: response.status ?? 200 });
    return respond(response);
  }) as typeof fetch;
}
