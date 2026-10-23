import type { StatusTone } from '@adminforge/ui';
import { lastRunView, type ProbeItem, type ProbeStatus, type ScheduleItem } from './schedules';

/**
 * Monitoring (Overview › Monitoring, /monitoring): the health of everything AdminForge watches — health checks and
 * synthetic transactions (probes), and the schedules that run reports, automations and sweeps — filtered by service,
 * function, tag, problems and text. Pure: the page and its tests share it.
 */

/** What an item does, for the Function filter: a health check by its kind, a schedule by its job. */
export const FUNCTIONS = [
  { key: 'availability', label: 'Availability' },
  { key: 'transactions', label: 'Synthetic transactions' },
  { key: 'configuration', label: 'Configuration checks' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'sign-ins', label: 'Sign-ins' },
  { key: 'licences', label: 'Licences' },
  { key: 'integrity', label: 'Audit log and credentials' },
  { key: 'reports', label: 'Reports' },
  { key: 'automations', label: 'Automations' },
  { key: 'sweeps', label: 'Check sweeps' },
  { key: 'maintenance', label: 'Maintenance' },
] as const;
export type FunctionKey = (typeof FUNCTIONS)[number]['key'];
export const FUNCTION_LABEL = Object.fromEntries(FUNCTIONS.map((f) => [f.key, f.label])) as Record<
  FunctionKey,
  string
>;

const CHECK_FUNCTION: Record<string, FunctionKey> = {
  http: 'availability',
  graph: 'availability',
  arm: 'availability',
  tokenAcquisition: 'availability',
  dnsResolve: 'availability',
  functionHealth: 'availability',
  mailFlow: 'transactions',
  fileRoundTrip: 'transactions',
  onlineMeeting: 'transactions',
  kql: 'configuration',
  graphCount: 'configuration',
  certExpiry: 'expiry',
  appCredentialExpiry: 'expiry',
  signInHealth: 'sign-ins',
  licenseThreshold: 'licences',
  auditChain: 'integrity',
  vaultCredentials: 'integrity',
};
const JOB_FUNCTION: Record<string, FunctionKey> = {
  report: 'reports',
  playbook: 'automations',
  script: 'automations',
  probe: 'sweeps',
  contentHealth: 'maintenance',
  news: 'maintenance',
};

export const probeFunction = (p: Pick<ProbeItem, 'kind'>): FunctionKey =>
  CHECK_FUNCTION[p.kind] ?? 'availability';
export const scheduleFunction = (s: Pick<ScheduleItem, 'job'>): FunctionKey =>
  JOB_FUNCTION[s.job.kind] ?? 'automations';

/** Probes that name no service. */
export const OTHER_SERVICE = 'other';

export const statusOf = (p: Pick<ProbeItem, 'latest'>): ProbeStatus => p.latest?.status ?? 'unknown';

/** The filters, as the URL holds them (comma-separated lists; empty = everything). */
export interface MonitoringFilters {
  services: string[];
  functions: string[];
  tags: string[];
  text: string;
  problems: boolean;
}

const VALUE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** A comma-separated list from the URL: known-safe values only, at most 30. */
export function listParam(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 1000) return undefined;
  const values = [...new Set(v.split(',').map((x) => x.trim()))].filter((x) => VALUE.test(x)).slice(0, 30);
  return values.length ? values.join(',') : undefined;
}
export const splitList = (v: string | undefined): string[] => (v ? v.split(',') : []);

/** The services a schedule touches: its own, or for a probe sweep the services of the probes it runs. */
export function scheduleServices(s: ScheduleItem, probes: readonly ProbeItem[]): string[] {
  if (s.group) return [s.group];
  const covers = s.covers;
  if (!covers) return [];
  const covered =
    'refs' in covers
      ? probes.filter((p) => covers.refs.includes(p.key))
      : probes.filter((p) => covers.tags.every((t) => p.tags.includes(t)));
  return [...new Set(covered.map((p) => p.group ?? OTHER_SERVICE))];
}

const matchesText = (text: string, fields: Array<string | null | undefined>) => {
  const q = text.trim().toLowerCase();
  return !q || fields.some((f) => !!f && f.toLowerCase().includes(q));
};
/** Any of the chosen tags (a tag filter widens within itself, like the other facets). */
const anyOf = (wanted: string[], have: readonly string[]) =>
  !wanted.length || wanted.some((w) => have.includes(w));

export function probeMatches(p: ProbeItem, f: MonitoringFilters): boolean {
  const status = statusOf(p);
  return (
    anyOf(f.services, [p.group ?? OTHER_SERVICE]) &&
    anyOf(f.functions, [probeFunction(p)]) &&
    anyOf(f.tags, p.tags) &&
    (!f.problems || status === 'warn' || status === 'crit') &&
    matchesText(f.text, [p.title, p.key, p.summary, p.latest?.message, ...p.tags])
  );
}

/** How a schedule is doing: its last run's outcome while it's on; off and awaiting approval say so. */
export function scheduleHealth(s: ScheduleItem): { tone: StatusTone; label: string } {
  if (!s.enabled)
    return s.pendingApprovalId
      ? { tone: 'warn', label: 'Awaiting approval' }
      : { tone: 'neutral', label: 'Off' };
  return s.lastRunAt || s.lastStatus
    ? lastRunView(s, { short: true })
    : { tone: 'neutral', label: 'Not run yet' };
}
const isProblem = (s: ScheduleItem) => s.enabled && ['warn', 'crit'].includes(scheduleHealth(s).tone);
export const failingSchedules = (items: readonly ScheduleItem[]) =>
  items.filter((s) => s.enabled && scheduleHealth(s).tone === 'crit');

export function scheduleMatches(
  s: ScheduleItem,
  f: MonitoringFilters,
  probes: readonly ProbeItem[],
): boolean {
  return (
    (!f.services.length || scheduleServices(s, probes).some((x) => f.services.includes(x))) &&
    anyOf(f.functions, [scheduleFunction(s)]) &&
    anyOf(f.tags, s.tags) &&
    (!f.problems || isProblem(s)) &&
    matchesText(f.text, [s.title, s.key, s.summary, s.job.ref, ...s.tags])
  );
}

/** Counts per facet option across every item (the facet pickers show them). */
export function facetCounts(probes: readonly ProbeItem[], schedules: readonly ScheduleItem[]) {
  const services = new Map<string, number>();
  const functions = new Map<string, number>();
  const tags = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const p of probes) {
    bump(services, p.group ?? OTHER_SERVICE);
    bump(functions, probeFunction(p));
    p.tags.forEach((t) => bump(tags, t));
  }
  for (const s of schedules) {
    scheduleServices(s, probes).forEach((x) => bump(services, x));
    bump(functions, scheduleFunction(s));
    s.tags.forEach((t) => bump(tags, t));
  }
  return { services, functions, tags };
}

const HOUR_MS = 3_600_000;
const RANK: Record<ProbeStatus, number> = { unknown: 0, ok: 1, warn: 2, crit: 3 };

/** One hour of results: when it starts, how many passed, degraded or failed, and the worst. */
export interface HourBucket {
  start: number;
  ok: number;
  warn: number;
  crit: number;
  worst: ProbeStatus;
}

/** The last `hours` whole hours up to now (oldest first), counting every result of these probes in each. */
export function hourlyBuckets(probes: readonly ProbeItem[], now: number, hours = 24): HourBucket[] {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const first = end - hours * HOUR_MS;
  const buckets: HourBucket[] = Array.from({ length: hours }, (_, i) => ({
    start: first + i * HOUR_MS,
    ok: 0,
    warn: 0,
    crit: 0,
    worst: 'unknown',
  }));
  for (const p of probes)
    for (const point of p.series) {
      const t = Date.parse(point.ts);
      if (!(t >= first && t < end) || point.status === 'unknown') continue;
      const b = buckets[Math.floor((t - first) / HOUR_MS)]!;
      b[point.status]++;
      if (RANK[point.status] > RANK[b.worst]) b.worst = point.status;
    }
  return buckets;
}

/** The share of results that passed in each hour (0–100), or null for an hour without results. */
export const passRates = (buckets: readonly HourBucket[]): Array<number | null> =>
  buckets.map((b) => {
    const total = b.ok + b.warn + b.crit;
    return total ? Math.round((b.ok / total) * 1000) / 10 : null;
  });

const hourText = (t: number) => `${new Date(t).toISOString().slice(11, 13)}:00`;

/** The runs of consecutive hours whose worst result is `status`, as "13:00–15:00" (UTC). */
export function hourRanges(buckets: readonly HourBucket[], status: ProbeStatus): string[] {
  const out: string[] = [];
  let from: number | null = null;
  for (let i = 0; i <= buckets.length; i++) {
    const b = buckets[i];
    if (b && b.worst === status) {
      from ??= b.start;
      continue;
    }
    if (from !== null) {
      out.push(`${hourText(from)}–${hourText(buckets[i - 1]!.start + HOUR_MS)}`);
      from = null;
    }
  }
  return out;
}

/** A timeline row in words: which hours failed, degraded or had no results (what the colours and heights show). */
export function rowSummary(buckets: readonly HourBucket[]): string {
  const part = (label: string, status: ProbeStatus) => {
    const r = hourRanges(buckets, status);
    return r.length ? `${label} ${r.join(', ')}` : null;
  };
  const parts = [part('failing', 'crit'), part('degraded', 'warn'), part('no results', 'unknown')].filter(
    Boolean,
  );
  if (!buckets.some((b) => b.worst !== 'unknown')) return 'no results in the last 24 hours';
  const healthy = !buckets.some((b) => b.worst === 'crit' || b.worst === 'warn');
  return `${healthy ? 'healthy' : ''}${healthy && parts.length ? '; ' : ''}${parts.join('; ')} (UTC)`;
}
