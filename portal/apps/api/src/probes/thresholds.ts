import { PROBE_METRICS, type Probe } from '@adminforge/schemas';
import type { ProbeStatus } from '../schedules/types';

/** Effective thresholds on a probe's primary metric (PROBE_METRICS), as the API and the evaluator use them. */
export interface Thresholds {
  warn: number | null;
  crit: number | null;
  unit: string;
  worse: 'higher' | 'lower';
  metric: string;
}

/**
 * `thresholds` win; otherwise the check's own limits: warnDays/critDays (expiry), maxPercent/critPercent (licences),
 * maxFailurePercent as the critical sign-in failure rate, and "any row warns" for KQL checks.
 */
export function effectiveThresholds(probe: Pick<Probe, 'check' | 'thresholds'>): Thresholds {
  const c = probe.check;
  const meta = PROBE_METRICS[c.kind];
  const t = probe.thresholds ?? {};
  let warn = t.warn ?? null;
  let crit = t.crit ?? null;
  if (c.kind === 'certExpiry' || c.kind === 'appCredentialExpiry') {
    warn ??= c.warnDays;
    crit ??= c.critDays;
  } else if (c.kind === 'licenseThreshold') {
    warn ??= c.maxPercent;
    crit ??= c.critPercent ?? null;
  } else if (c.kind === 'signInHealth') {
    crit ??= c.maxFailurePercent;
  } else if (c.kind === 'kql' && warn === null && crit === null) {
    warn = 1;
  }
  const unit = c.kind === 'kql' && c.metric !== 'rowCount' ? c.metric.column : meta.unit;
  return { warn, crit, unit, worse: meta.worse, metric: meta.metric };
}

/** ok / warn / crit for a metric (inclusive: reaching a threshold counts). */
export function classify(
  metric: number,
  t: Pick<Thresholds, 'warn' | 'crit' | 'worse'>,
): Exclude<ProbeStatus, 'error'> {
  const reached = (limit: number | null) =>
    limit !== null && (t.worse === 'higher' ? metric >= limit : metric <= limit);
  if (reached(t.crit)) return 'crit';
  if (reached(t.warn)) return 'warn';
  return 'ok';
}

/** "warn ≥ 1, crit ≥ 10" — for messages. */
export function describeThresholds(t: Thresholds): string {
  const op = t.worse === 'higher' ? '≥' : '≤';
  return [t.warn !== null ? `warn ${op} ${t.warn}` : '', t.crit !== null ? `crit ${op} ${t.crit}` : '']
    .filter(Boolean)
    .join(', ');
}

const RANK: Record<ProbeStatus, number> = { ok: 0, warn: 1, crit: 2, error: 3 };
export const worst = (a: ProbeStatus, b: ProbeStatus): ProbeStatus => (RANK[a] >= RANK[b] ? a : b);
