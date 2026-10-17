import { z } from 'zod';

/**
 * Per-call timeouts for the outbound executor (OUTBOUND_TIMEOUT_OVERRIDES). Most Microsoft calls get
 * OUTBOUND_TIMEOUT_MS and, when an attempt times out, one more try. Some calls are known to be slow on a big tenant —
 * sign-in and audit logs, usage reports, Log Analytics — and a second 30 s attempt rarely does better than the first:
 * those get one longer attempt instead (an override never retries a timeout).
 *
 * Format: comma-separated `service=ms` or `service:/path-prefix=ms`, e.g. `logAnalytics=120000,graph:/auditLogs/=120000`.
 * The longest matching prefix wins; a service-wide entry applies when no prefix matches.
 */

export const OUTBOUND_TIMEOUT_SERVICES = ['graph', 'arm', 'logAnalytics', 'function'] as const;
export type TimeoutService = (typeof OUTBOUND_TIMEOUT_SERVICES)[number];

export interface TimeoutOverride {
  service: TimeoutService;
  /** Path prefix (as sent, before the query), or undefined for the whole service. */
  prefix?: string;
  ms: number;
}

/** The default: the slow Microsoft reads get one 2-minute attempt. */
export const DEFAULT_TIMEOUT_OVERRIDES =
  'logAnalytics=120000,graph:/auditLogs/=120000,graph:/reports/=120000,graph:/security/runHuntingQuery=120000';

const ENTRY = /^(graph|arm|logAnalytics|function)(?::(\/[^=\s]*))?=(\d+)$/;

/** Parses OUTBOUND_TIMEOUT_OVERRIDES; empty entries are ignored, anything malformed fails config loading. */
export const TimeoutOverrideList = z.string().transform((s, ctx): TimeoutOverride[] => {
  const out: TimeoutOverride[] = [];
  for (const raw of s
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const m = ENTRY.exec(raw);
    const ms = m ? Number(m[3]) : NaN;
    if (!m || ms < 1000 || ms > 600_000) {
      ctx.addIssue({
        code: 'custom',
        message: `"${raw}" must be service=ms or service:/path=ms (service: ${OUTBOUND_TIMEOUT_SERVICES.join(', ')}; 1000–600000 ms)`,
      });
      return z.NEVER;
    }
    out.push({ service: m[1] as TimeoutService, ...(m[2] ? { prefix: m[2] } : {}), ms });
  }
  return out;
});

/** The override for a call, if any: the longest matching prefix, else the service-wide entry. */
export function timeoutOverride(
  overrides: readonly TimeoutOverride[] | undefined,
  service: string,
  path: string,
): TimeoutOverride | undefined {
  let best: TimeoutOverride | undefined;
  for (const o of overrides ?? []) {
    if (o.service !== service) continue;
    if (o.prefix === undefined) {
      if (!best) best = o;
      continue;
    }
    if (
      path.toLowerCase().startsWith(o.prefix.toLowerCase()) &&
      (best?.prefix?.length ?? -1) < o.prefix.length
    )
      best = o;
  }
  return best;
}
