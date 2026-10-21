import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ApiError, RESPONSE_TOO_LARGE, readBodyText } from '@adminforge/connectors';
import { NEWS_FEED_HOSTS, isFeedUrl } from '@adminforge/schemas';
import { AppError } from '../errors';
import { defaultLookup, isNonPublicAddress, type HostLookup } from '../probes/addresses';

/**
 * Fetching a public feed (SECURITY.md, News and changes): https only, the host must be on NEWS_FEED_HOSTS and resolve to
 * public addresses, redirects are followed by hand (at most 3) and only to another allow-listed host, 20 s per request,
 * 8 MB per response after decompression (streamed), conditional GET with the ETag / Last-Modified of the previous run. The request carries
 * a fixed User-Agent and nothing about this installation (no portal URL, no cookies, no tokens).
 *
 * On the real network (the platform fetch, no injected lookup) the connection itself is pinned: the socket resolves the
 * host through a lookup that refuses non-public addresses, so the address that was checked is the address connected to
 * (no DNS rebinding between the check and the connect). DNS answers are bounded by FEED_DNS_TIMEOUT_MS.
 */

export const FEED_TIMEOUT_MS = 20_000;
export const FEED_DNS_TIMEOUT_MS = 5_000;
/** Decompressed (the full Microsoft Graph changelog is about 4.5 MB). */
export const FEED_MAX_BYTES = 8 * 1024 * 1024;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_USER_AGENT = 'AdminForge-News/1.0';

export interface FeedFetchDeps {
  fetch: typeof fetch;
  /** Host → addresses (tests and DATA_MODE=fixtures inject one). */
  lookup?: HostLookup;
  /** Tests: the resolver the pinned connection uses (default: the system resolver). Forces the pinned transport. */
  connectLookup?: HostLookup;
}

export type FeedFetchResult =
  | { status: 'ok'; text: string; etag: string | null; lastModified: string | null }
  | { status: 'not_modified' };

/** Marks a connect-time refusal so the fetch error can be reported as "not allowed", not "unreachable". */
const NOT_PUBLIC = 'ERR_ADMINFORGE_NOT_PUBLIC';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEOUT' })),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible resolver for the socket: every address the host has must be public, or the connection is
 * refused before it is made. Exported for tests.
 */
export function checkedConnectLookup(resolve: HostLookup = defaultLookup, timeoutMs = FEED_DNS_TIMEOUT_MS) {
  return (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions | number | undefined,
    callback: LookupCallback,
  ): void => {
    const all = typeof options === 'object' && options !== null && options.all === true;
    const family = typeof options === 'number' ? options : typeof options === 'object' ? options?.family : 0;
    withTimeout(resolve(hostname), timeoutMs, `DNS lookup of ${hostname}`)
      .then((found) => {
        const wanted = found
          .map((address) => ({ address, family: isIP(address) }))
          .filter((a) => a.family !== 0 && (!family || family === a.family));
        if (!found.length || found.some(isNonPublicAddress) || !wanted.length) {
          const err: NodeJS.ErrnoException = Object.assign(
            new Error(`${hostname} resolves to a non-public address`),
            { code: NOT_PUBLIC },
          );
          return callback(err, all ? [] : '');
        }
        if (all) return callback(null, wanted);
        return callback(null, wanted[0]!.address, wanted[0]!.family);
      })
      .catch((e: unknown) => {
        const err = e as NodeJS.ErrnoException;
        callback(
          Object.assign(err instanceof Error ? err : new Error(String(e)), {
            code: err?.code ?? 'ENOTFOUND',
          }),
          all ? [] : '',
        );
      });
  };
}

let pinnedAgent: Agent | undefined;
/** A dispatcher whose sockets resolve with checkedConnectLookup (HTTP probes reuse it, probes/checks.ts). */
export const newPinnedAgent = (resolve?: HostLookup) =>
  new Agent({
    connect: { lookup: checkedConnectLookup(resolve) as never, timeout: 10_000 },
    keepAliveTimeout: 10_000,
  });

/** undici's fetch through a dispatcher whose sockets resolve with checkedConnectLookup. */
export function pinnedFetch(agent: Agent): typeof fetch {
  return ((input: string, init: RequestInit) =>
    undiciFetch(input, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}

/**
 * The transport for feed requests: the pinned connection whenever the real network is used (the platform fetch with the
 * system resolver), or when a test asks for it with `connectLookup`; an injected fake fetch (tests, DATA_MODE=fixtures)
 * is used as is — it never opens a socket.
 */
function feedTransport(deps: FeedFetchDeps): typeof fetch {
  if (deps.connectLookup) return pinnedFetch(newPinnedAgent(deps.connectLookup));
  if (deps.lookup || deps.fetch !== globalThis.fetch) return deps.fetch;
  pinnedAgent ??= newPinnedAgent();
  return pinnedFetch(pinnedAgent);
}

/** True when an error (or one of its causes) is the pinned lookup refusing a non-public address. */
export function refusedAtConnect(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { code?: string }).code === NOT_PUBLIC) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const refused = (why: string) =>
  new AppError(502, 'feed_not_allowed', `AdminForge did not fetch the feed: ${why}.`, {
    hint: `Public feeds are fetched over https from ${NEWS_FEED_HOSTS.join(', ')} only. Adding a host is a reviewed code change (SECURITY.md).`,
  });

function feedFailed(status: number, host: string): AppError {
  return new AppError(502, 'feed_failed', `${host} answered HTTP ${status} for the feed.`, {
    hint:
      status === 404 || status === 410
        ? 'The feed may have moved. Check the URL in the feed definition against the publisher’s site.'
        : 'The next hourly run tries again. If it keeps failing, check the publisher’s site.',
  });
}

async function assertPublic(url: URL, lookup: HostLookup): Promise<void> {
  if (!isFeedUrl(url.href))
    throw refused(`${url.protocol === 'https:' ? url.hostname : url.protocol} is not allowed`);
  const host = url.hostname;
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : await withTimeout(lookup(host), FEED_DNS_TIMEOUT_MS, `DNS lookup of ${host}`);
  } catch {
    throw new AppError(502, 'feed_unreachable', `${host} could not be resolved.`, {
      hint: 'Check this host’s DNS and outbound internet access; the next hourly run tries again.',
    });
  }
  if (!addresses.length || addresses.some(isNonPublicAddress))
    throw refused(`${host} resolves to a private, loopback or link-local address`);
}

/** GET a public feed under the rules above. */
export async function fetchFeed(
  rawUrl: string,
  deps: FeedFetchDeps,
  opts: { etag?: string | null; lastModified?: string | null; signal?: AbortSignal } = {},
): Promise<FeedFetchResult> {
  const lookup = deps.lookup ?? defaultLookup;
  const transport = feedTransport(deps);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refused('the URL is not valid');
  }
  for (let hop = 0; ; hop++) {
    await assertPublic(url, lookup);
    const headers: Record<string, string> = {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
      'user-agent': FEED_USER_AGENT,
      // fetch decompresses; the size cap applies to the decompressed text.
      'accept-encoding': 'gzip',
    };
    // Validators belong to the URL that produced them: only the first request carries them.
    if (hop === 0 && opts.etag) headers['if-none-match'] = opts.etag;
    if (hop === 0 && opts.lastModified) headers['if-modified-since'] = opts.lastModified;
    const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await transport(url.href, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      // The address changed between the check above and the connect, to a non-public one: refused, not retried.
      if (refusedAtConnect(err))
        throw refused(`${url.hostname} resolves to a private, loopback or link-local address`);
      const timedOut = timeout.aborted;
      throw new AppError(
        502,
        'feed_unreachable',
        `${url.hostname} ${timedOut ? 'did not answer within 20 seconds' : 'could not be reached'}.`,
        {
          hint: 'Check this host’s outbound internet access; the next hourly run tries again.',
        },
      );
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 'not_modified' };
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) throw feedFailed(res.status, url.hostname);
      if (hop >= FEED_MAX_REDIRECTS) throw refused(`it redirected more than ${FEED_MAX_REDIRECTS} times`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw refused('it redirected to an invalid URL');
      }
      if (!isFeedUrl(next.href))
        throw refused(
          `it redirected to ${next.protocol === 'https:' ? next.hostname : next.protocol}, which is not allowed`,
        );
      url = next;
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw feedFailed(res.status, url.hostname);
    }
    try {
      const { text } = await readBodyText(res, FEED_MAX_BYTES, { onLimit: 'throw', url: url.href });
      return {
        status: 'ok',
        text,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === RESPONSE_TOO_LARGE)
        throw new AppError(
          502,
          'feed_too_large',
          `The feed from ${url.hostname} is larger than the 8 MB AdminForge accepts.`,
          {
            hint: 'Use a narrower feed URL (most publishers offer per-product feeds).',
          },
        );
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      throw new AppError(502, 'feed_unreachable', `The feed from ${url.hostname} stopped part-way.`, {
        hint: 'The next hourly run tries again.',
      });
    }
  }
}
