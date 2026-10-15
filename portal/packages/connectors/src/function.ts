import { buildQuery } from './graph';
import { ApiError, createHttpClient, type HttpClientOptions } from './http';
import type { Mode } from './types';

/** One allowlisted operation of a connection (mirrors `kind: connection` content). */
export interface FunctionOperation {
  method?: string;
  /** Relative to baseUrl; `{name}` placeholders are filled from pathParams. */
  path: string;
  mode: Mode;
  idempotent?: boolean;
}

/** An Entra-secured API (e.g. your Function App) reached with its own audience's token. */
export interface FunctionConnection {
  id: string;
  baseUrl: string;
  operations: Record<string, FunctionOperation>;
}

export interface FunctionCall {
  pathParams?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FunctionResult<T> {
  data: T;
  status: number;
  requestId?: string;
  ms: number;
  mode: Mode;
}

export type FunctionClientOptions = Omit<HttpClientOptions, 'requestIdHeader'> & {
  connection: FunctionConnection;
  /** Write operations are refused unless the caller holds an armed session for a declared write (default false). */
  allowWrite?: boolean;
};

const BASE_URL = /^(https:\/\/[^\s/?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s?#]*)?$/;

function fillPath(op: string, path: string, params: Record<string, unknown> = {}): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === '')
      throw new Error(`Operation "${op}" needs path parameter "${name}".`);
    const s = String(v);
    if (s === '.' || s === '..') throw new Error(`Invalid value for path parameter "${name}".`);
    return encodeURIComponent(s);
  });
}

/** Calls named operations of a connection; anything not in the allowlist is refused. */
export function createFunctionClient(opts: FunctionClientOptions) {
  const { connection } = opts;
  if (!BASE_URL.test(connection.baseUrl))
    throw new Error(`Connection ${connection.id}: baseUrl must be https:// (http only for localhost).`);
  const base = connection.baseUrl.replace(/\/+$/, '');
  const http = createHttpClient({
    ...opts,
    correlationHeader: opts.correlationHeader ?? 'x-ms-client-request-id',
    requestIdHeader: 'x-ms-request-id',
  });

  const operation = (name: string): FunctionOperation | undefined =>
    Object.hasOwn(connection.operations, name) ? connection.operations[name] : undefined;

  /** The method, URL and mode an operation call resolves to (used for policy checks and provenance). */
  function resolve(
    name: string,
    call: FunctionCall = {},
  ): { method: string; url: string; path: string; mode: Mode } {
    const op = operation(name);
    if (!op) throw new Error(`Connection ${connection.id} has no operation "${name}".`);
    const path = fillPath(name, op.path, call.pathParams);
    const qs = buildQuery(call.query);
    return {
      method: (op.method ?? 'GET').toUpperCase(),
      url: `${base}${path}${qs ? `?${qs}` : ''}`,
      path,
      mode: op.mode,
    };
  }

  async function call<T>(name: string, input: FunctionCall = {}): Promise<FunctionResult<T>> {
    const { method, url, mode } = resolve(name, input);
    if (mode === 'write' && !opts.allowWrite)
      throw new ApiError(
        403,
        'WriteNotAllowed',
        `Operation "${name}" on ${connection.id} changes data. Arm write access to continue.`,
      );
    const op = operation(name)!;
    const r = await http.send<T>({
      method,
      url,
      headers: input.headers,
      body: input.body,
      ...(op.idempotent !== undefined ? { idempotent: op.idempotent } : {}),
    });
    return { data: r.data, status: r.status, requestId: r.requestId, ms: r.ms, mode };
  }

  return { call, resolve, operation };
}
export type FunctionClient = ReturnType<typeof createFunctionClient>;
