import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BACKGROUND_HEADER, sessionCookieName } from './auth/session-plugin';
import type { Config } from './config';
import { AppError } from './errors';

/**
 * Request rate limits, keyed per signed-in session rather than per client address: behind a corporate NAT every
 * engineer shares one address, so a per-address limit would let one busy colleague lock everyone out.
 *
 * - RATE_LIMIT_PER_MINUTE per session (per address before sign-in), per-route limits on top keyed the same way;
 * - requests the browser marks as background (`X-AdminForge-Background: 1`: polling, refetch on focus) count against
 *   their own allowance, RATE_LIMIT_BACKGROUND_PER_MINUTE, so they can't starve what the person clicks — on routes
 *   with their own limit (arming, exports, …) they share it, so the header never doubles a tight limit;
 * - sign-in itself (`/auth/login`, `/auth/callback`) counts per address, whatever cookie comes with it:
 *   RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE (an invented cookie must not buy a fresh sign-in allowance);
 * - requests without a valid session to `/api` and `/auth` share RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE per
 *   address (checked once the session is known);
 * - RATE_LIMIT_PER_ADDRESS_PER_MINUTE caps one address across all its sessions.
 *
 * Addresses are grouped: an IPv4 address on its own, an IPv6 address by its /64 (one client usually holds a whole
 * /64), IPv4-mapped IPv6 as IPv4. The cookie is hashed and never validated in the limiter (that costs a database
 * read); an unknown cookie gets its own bucket, bounded by the address caps.
 */

type LimitConfig = Pick<
  Config,
  | 'NODE_ENV'
  | 'RATE_LIMIT_PER_MINUTE'
  | 'RATE_LIMIT_BACKGROUND_PER_MINUTE'
  | 'RATE_LIMIT_PER_ADDRESS_PER_MINUTE'
  | 'RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE'
  | 'RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE'
>;

const BACKGROUND_SUFFIX = '|bg';

/** Sign-in routes: limited per address, never per (unverified) cookie. */
const SIGN_IN_ROUTES = new Set(['/auth/login', '/auth/callback']);

/** The client an address belongs to: IPv4 itself, IPv6 its /64, IPv4-mapped IPv6 the IPv4 address. */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]!.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${full
    .slice(0, 4)
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** The bucket a request counts against: `s:<cookie hash>` (`|bg` for background), else `ip:<address>`. */
export function rateLimitKey(
  request: Pick<FastifyRequest, 'cookies' | 'headers' | 'ip'> & {
    routeOptions?: { url?: string; config?: { rateLimit?: unknown } };
  },
  cookieName: string,
): string {
  const route = request.routeOptions?.url;
  if (route && SIGN_IN_ROUTES.has(route)) return `ip:${addressKey(request.ip)}`;
  const sid = request.cookies?.[cookieName];
  if (typeof sid !== 'string' || sid.length < 16 || sid.length > 512) return `ip:${addressKey(request.ip)}`;
  const key = `s:${createHash('sha256').update(sid).digest('base64url').slice(0, 22)}`;
  // Background requests get their own allowance only under the global limit, never on a route with its own.
  const ownLimit = request.routeOptions?.config?.rateLimit !== undefined;
  return request.headers[BACKGROUND_HEADER] === '1' && !ownLimit ? `${key}${BACKGROUND_SUFFIX}` : key;
}

/** Options for @fastify/rate-limit (registered after @fastify/cookie, so the session cookie is parsed). */
export function rateLimitOptions(config: LimitConfig): RateLimitPluginOptions {
  const cookieName = sessionCookieName(config);
  return {
    timeWindow: '1 minute',
    keyGenerator: (request) => rateLimitKey(request, cookieName),
    max: (_request, key) =>
      key.endsWith(BACKGROUND_SUFFIX)
        ? config.RATE_LIMIT_BACKGROUND_PER_MINUTE
        : config.RATE_LIMIT_PER_MINUTE,
  };
}

/** The route limit of `/auth/login` and `/auth/callback`: per address (rateLimitKey), RATE_LIMIT_SIGNIN_…. */
export const signInRateLimit = (config: Pick<Config, 'RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE'>) => ({
  max: config.RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE,
  timeWindow: '1 minute',
});

/** Fixed one-minute window per key. */
export class AddressCap {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request; false when `key` is over its limit for the current minute. */
  allow(key: string): boolean {
    return this.count(key) <= this.limit;
  }

  /** Counts one event and returns how many `key` had in the current minute (this one included). */
  count(key: string): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (this.windows.size >= 50_000) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    return ++w.count;
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
  }

  get size(): number {
    return this.windows.size;
  }
}

const tooMany = (what: string) =>
  new AppError(429, 'rate_limited', `Too many requests from your network address${what}.`, {
    hint: 'Wait a minute and try again.',
  });

/** One address across all its sessions (RATE_LIMIT_PER_ADDRESS_PER_MINUTE). */
export function registerAddressCap(app: FastifyInstance, config: LimitConfig): void {
  const cap = new AddressCap(config.RATE_LIMIT_PER_ADDRESS_PER_MINUTE);
  app.addHook('onRequest', async (request) => {
    if (!cap.allow(addressKey(request.ip))) throw tooMany('');
  });
}

const CAPPED_WITHOUT_SESSION = /^\/(api|auth)(\/|$|\?)/;

/**
 * Requests without a valid session to `/api` and `/auth` (RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE per address).
 * Registered after the session hook (a preHandler), so a valid session is known; the SPA's own files and the health
 * checks don't count.
 */
export function registerAnonymousCap(app: FastifyInstance, config: LimitConfig): void {
  const cap = new AddressCap(config.RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE);
  app.addHook('preHandler', async (request) => {
    if ((request as { session?: unknown }).session) return;
    if (!CAPPED_WITHOUT_SESSION.test(request.url)) return;
    if (!cap.allow(addressKey(request.ip))) throw tooMany(' without a signed-in session');
  });
}

/** Most failed-sign-in audit events per address per minute; further ones are counted and reported with the next. */
export const SIGNIN_FAILURE_AUDITS_PER_MINUTE = 10;

/**
 * Throttles failed-sign-in audit events per address: anyone can send a browser to `/auth/callback` with an error,
 * so without it one address could fill the audit log. The first SIGNIN_FAILURE_AUDITS_PER_MINUTE a minute are
 * written; the rest are counted and the count goes with the next one written (`suppressed`).
 */
export class SignInFailureAudits {
  private readonly cap: AddressCap;
  private readonly suppressed = new Map<string, number>();
  constructor(now?: () => number) {
    this.cap = new AddressCap(SIGNIN_FAILURE_AUDITS_PER_MINUTE, now);
  }
  /** `{ write: false }` to skip this event; otherwise how many were skipped before it. */
  next(ip: string): { write: false } | { write: true; suppressed: number } {
    const key = addressKey(ip);
    if (this.cap.count(key) > SIGNIN_FAILURE_AUDITS_PER_MINUTE) {
      if (this.suppressed.size < 50_000 || this.suppressed.has(key))
        this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return { write: false };
    }
    const suppressed = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    return { write: true, suppressed };
  }
}
