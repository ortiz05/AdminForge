import { assertSafePath, buildQuery } from './graph';
import {
  abortableSleep,
  afterAcceptance,
  ApiError,
  createHttpClient,
  retryDelay,
  type HttpClientOptions,
  type HttpResult,
} from './http';
import { defaultSleep } from './types';

/** An Azure Resource Manager request. `apiVersion` is required on every call. */
export interface ArmRequest {
  method?: string;
  /** Relative to the ARM base, e.g. `/subscriptions/{id}/resourceGroups`. */
  path: string;
  apiVersion: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ArmResult<T> {
  data: T;
  status: number;
  requestId?: string;
  ms: number;
  headers: Headers;
}

export type ArmClientOptions = Omit<HttpClientOptions, 'correlationHeader' | 'requestIdHeader'> & {
  baseUrl?: string;
  /** Poll interval for long-running operations when the service sends no Retry-After (default 5 s). */
  pollIntervalMs?: number;
  /** Give up on a long-running operation after this long (default 30 min). */
  maxPollMs?: number;
};

export const ARM_BASE_URL = 'https://management.azure.com';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled']);

/** Builds an ARM URL; throws when api-version is missing or the path is unsafe. */
export function buildArmUrl(base: string, req: ArmRequest): string {
  if (!req.apiVersion || !req.apiVersion.trim())
    throw new Error(`ARM requests need an api-version (${req.method ?? 'GET'} ${req.path}).`);
  assertSafePath(req.path, 'ARM');
  const { 'api-version': _ignored, ...rest } = req.query ?? {};
  return `${base}${req.path}?${buildQuery({ 'api-version': req.apiVersion, ...rest })}`;
}

/** ARM client: api-version enforced, nextLink paging, x-ms-client-request-id correlation, long-running operation polling. */
export function createArmClient(opts: ArmClientOptions) {
  const base = (opts.baseUrl ?? ARM_BASE_URL).replace(/\/+$/, '');
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const maxPollMs = opts.maxPollMs ?? 30 * 60_000;
  const http = createHttpClient({
    ...opts,
    correlationHeader: 'x-ms-client-request-id',
    requestIdHeader: 'x-ms-request-id',
  });

  const ensureArm = (url: string, what: string): string => {
    if (!url.startsWith(`${base}/`))
      throw new Error(`${what} points outside Azure Resource Manager; refusing to follow it.`);
    return url;
  };

  async function request<T>(req: ArmRequest, url = buildArmUrl(base, req)): Promise<ArmResult<T>> {
    const isQuery =
      (req.method ?? 'GET').toUpperCase() === 'POST' &&
      /\/providers\/Microsoft\.ResourceGraph\/resources$/i.test(req.path);
    const r: HttpResult<T> = await http.send<T>({
      method: req.method,
      url,
      headers: req.headers,
      body: req.body,
      ...(isQuery ? { idempotent: true } : {}),
    });
    return { data: r.data, status: r.status, requestId: r.requestId, ms: r.ms, headers: r.headers };
  }

  const get = <T>(url: string) =>
    http.send<T>({ method: 'GET', url }).then((r) => ({
      data: r.data,
      status: r.status,
      requestId: r.requestId,
      ms: r.ms,
      headers: r.headers,
    }));

  /**
   * A read after Azure accepted the request (a poll, the final result). The caller answers a sign-in (claims)
   * challenge by running the whole call again with a new token, which would send the accepted change a second time
   * (security review): here the challenge fails the step instead, saying the change was accepted.
   */
  const afterAccepted = <T>(url: string) =>
    get<T>(url).catch((err: unknown) => {
      throw afterAcceptance(
        err,
        'Azure accepted the change, but reading whether it finished needed a new sign-in. It was not sent again: check the resource before running anything again.',
      );
    });

  /** Follows `nextLink`; refuses links that leave ARM. */
  async function* pages<T>(req: ArmRequest, maxPages = 50): AsyncGenerator<T[]> {
    let next: string | undefined = buildArmUrl(base, req);
    for (let i = 0; next && i < maxPages; i++) {
      const { data }: ArmResult<{ value?: T[]; nextLink?: string }> = await request(req, next);
      yield data?.value ?? [];
      next = data?.nextLink ?? undefined;
      if (next) ensureArm(next, 'nextLink');
    }
  }

  async function all<T>(req: ArmRequest, maxItems = 5000): Promise<T[]> {
    const out: T[] = [];
    for await (const page of pages<T>(req)) {
      out.push(...page);
      if (out.length >= maxItems) return out.slice(0, maxItems);
    }
    return out;
  }

  /**
   * Completes a long-running operation started by `req` (initial response `initial`):
   * Azure-AsyncOperation is polled until Succeeded/Failed/Canceled, then the final result is fetched
   * (PUT/PATCH → the resource; POST → Location when given); Location alone is polled until it stops returning 202;
   * a 201 PUT with a non-terminal provisioningState is polled on the resource itself.
   */
  async function waitForCompletion<T>(req: ArmRequest, initial: ArmResult<unknown>): Promise<ArmResult<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    const asyncOp = initial.headers.get('azure-asyncoperation');
    const location = initial.headers.get('location');
    const resourceUrl = buildArmUrl(base, req);
    const started = Date.now();
    let retryAfter = initial.headers.get('retry-after');
    const wait = async () => {
      if (Date.now() - started > maxPollMs)
        throw new ApiError(
          0,
          'OperationTimedOut',
          `The Azure operation did not finish within ${Math.round(maxPollMs / 1000)} s.`,
          initial.requestId,
        );
      // The caller's abort (a cancelled run, a stopping pod, a schedule's timeout) ends the wait between polls too,
      // not only the polls themselves (D-23b): the wait can otherwise last up to maxPollMs.
      await abortableSleep(
        sleep,
        retryAfter !== null ? retryDelay(retryAfter, 0) : pollIntervalMs,
        opts.signal,
      );
    };
    const provisioning = (d: unknown) =>
      (d as { properties?: { provisioningState?: string } } | undefined)?.properties?.provisioningState;

    if (asyncOp) {
      ensureArm(asyncOp, 'Azure-AsyncOperation');
      for (;;) {
        await wait();
        const poll = await afterAccepted<{ status?: string; error?: { code?: string; message?: string } }>(
          asyncOp,
        );
        retryAfter = poll.headers.get('retry-after');
        const status = (poll.data?.status ?? '').toLowerCase();
        if (!TERMINAL.has(status)) continue;
        if (status !== 'succeeded')
          throw new ApiError(
            poll.status,
            poll.data?.error?.code ?? 'OperationFailed',
            poll.data?.error?.message ?? `The Azure operation ended as ${poll.data?.status}.`,
            poll.requestId,
          );
        if (method === 'PUT' || method === 'PATCH') return afterAccepted<T>(resourceUrl);
        if (method === 'POST' && location) return afterAccepted<T>(ensureArm(location, 'Location'));
        return poll as ArmResult<T>;
      }
    }
    if (location) {
      ensureArm(location, 'Location');
      for (;;) {
        await wait();
        const poll = await afterAccepted<T>(location);
        retryAfter = poll.headers.get('retry-after');
        if (poll.status !== 202) return poll;
      }
    }
    if (
      method === 'PUT' &&
      initial.status === 201 &&
      provisioning(initial.data) &&
      !TERMINAL.has(provisioning(initial.data)!.toLowerCase())
    ) {
      for (;;) {
        await wait();
        const poll = await afterAccepted<T>(resourceUrl);
        retryAfter = poll.headers.get('retry-after');
        const state = provisioning(poll.data)?.toLowerCase();
        if (!state || state === 'succeeded') return poll;
        if (TERMINAL.has(state))
          throw new ApiError(
            poll.status,
            'OperationFailed',
            `The Azure resource ended in provisioning state ${provisioning(poll.data)}.`,
            poll.requestId,
          );
      }
    }
    return initial as ArmResult<T>;
  }

  /** Sends the request and, for 201/202 long-running responses, waits for the final result. */
  async function requestAndWait<T>(req: ArmRequest): Promise<ArmResult<T>> {
    const initial = await request<unknown>(req);
    if (initial.status !== 201 && initial.status !== 202) return initial as ArmResult<T>;
    return waitForCompletion<T>(req, initial);
  }

  return { request, pages, all, waitForCompletion, requestAndWait };
}
export type ArmClient = ReturnType<typeof createArmClient>;
