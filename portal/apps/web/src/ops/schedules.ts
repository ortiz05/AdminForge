import { queryOptions } from '@tanstack/react-query';
import type { StatusTone } from '@adminforge/ui';
import { api, isRecord, RedirectResponse } from '../lib/api';
import { arr, bool, listOf, num, parser, pick, query, rec } from '../runs/json';

/**
 * Schedules and synthetic probes (R6, ADR-011) — built against the scheduler contract:
 *   GET   /api/schedules                      → { items: Schedule[] }
 *   PATCH /api/schedules/:key { enabled }     → 200 (done) | 202 { approvalId } (write-capable: second person must approve)
 *   POST  /api/schedules/:key/run             → { scheduleRunId }
 *   GET   /api/schedules/:key/runs?cursor=    → { items: ScheduleRun[], cursor? }
 *   GET   /api/probes                         → { items: Probe[] }
 *   GET   /api/probes/:key/results?since=     → { items: ProbePoint[] }
 *   PUT   /api/schedules/:key                 → ScheduleItem (portal report schedules, when `canManage`)
 *   DELETE /api/schedules/:key                → 204 (portal report schedules, when `canManage`)
 * Creating a report schedule (POST /api/schedules) lives with the report catalogue (reports/catalog.ts).
 */

export type JobKind = 'report' | 'playbook' | 'probe' | 'script' | 'contentHealth';

export interface ScheduleItem {
  key: string;
  title: string;
  summary: string | null;
  cron: string;
  cronText: string | null;
  timezone: string;
  enabled: boolean;
  /** `automation`, `app:<name>` or `user` (ADR-014). */
  identity: string;
  /** Who it runs as, and for a schedule that uses its creator's access, whether that still works. */
  runsAs: RunsAs;
  /** `params`: report jobs' parameter values (the rest use the report's defaults). */
  job: { kind: JobKind | string; ref: string | null; params: Record<string, unknown> | null };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: boolean;
  approvedBy: string[];
  source: 'content' | 'portal';
  /** Set while an enable request waits for its second approver. */
  pendingApprovalId: string | null;
  /** Who created a portal schedule (UPN); null for content schedules. */
  createdBy: string | null;
  /** The caller may edit or delete it: a portal schedule they created, or any portal schedule for a Portal Admin. */
  canManage: boolean;
  /** Report jobs: what the file goes to (configuration key names and labels, never addresses). */
  delivery: ScheduleDelivery[];
  /** Report jobs: who hears about a failed run. */
  notify: ScheduleTarget[];
}

/** Who a schedule runs as (ADR-014). */
export interface RunsAs {
  kind: 'automation' | 'app' | 'user';
  /** The app identity's name, or the creator's UPN. */
  name: string | null;
  /** "automation identity", "app identity reports-team", "avery@example.com (their own access)". */
  label: string;
  /** Creator schedules: whether the creator's sign-in for it works. */
  signIn: 'signed_in' | 'needs_sign_in' | 'not_signed_in' | null;
  /** Creator schedules: the caller created it, so they can sign in for it. */
  canSignIn: boolean;
}

const AUTOMATION_RUNS_AS: RunsAs = {
  kind: 'automation',
  name: null,
  label: 'automation identity',
  signIn: null,
  canSignIn: false,
};

export function readRunsAs(raw: unknown): RunsAs {
  const o = rec(raw);
  const kind = o.kind === 'app' || o.kind === 'user' ? o.kind : 'automation';
  if (kind === 'automation') return AUTOMATION_RUNS_AS;
  const signIn =
    o.signIn === 'signed_in' || o.signIn === 'needs_sign_in' || o.signIn === 'not_signed_in'
      ? o.signIn
      : null;
  return {
    kind,
    name: pick(o, 'name') ?? null,
    label: pick(o, 'label') ?? (kind === 'app' ? 'an app identity' : 'its creator'),
    signIn: kind === 'user' ? (signIn ?? 'not_signed_in') : null,
    canSignIn: kind === 'user' && (bool(o.canSignIn) ?? false),
  };
}

/** "as the automation identity" / "as app identity reports-team" / "with avery@example.com’s own access". */
export function runsAsPhrase(r: RunsAs): string {
  if (r.kind === 'user') return r.name ? `with ${r.name}’s own access` : 'with its creator’s own access';
  return r.kind === 'app' ? `as app identity ${r.name ?? ''}`.trim() : 'as the automation identity';
}

/** "Runs as the automation identity", "Runs as app identity reports-team", "Runs with avery@example.com’s own access". */
export const runsAsSentence = (r: RunsAs) => `Runs ${runsAsPhrase(r)}`;

/** "Automation", "App: reports-team", "avery@example.com" (their own access) — for a list cell (`label` is its title). */
export function runsAsShort(r: RunsAs): string {
  if (r.kind === 'app') return `App: ${r.name ?? ''}`;
  if (r.kind === 'user') return r.name ?? 'Its creator';
  return 'Automation';
}

/** A creator schedule that can't run until its creator signs in for it; null when nothing is needed. */
export function signInView(r: RunsAs): { tone: StatusTone; label: string } | null {
  if (r.kind !== 'user' || r.signIn === 'signed_in') return null;
  return r.signIn === 'needs_sign_in'
    ? { tone: 'warn', label: 'Needs sign-in' }
    : { tone: 'warn', label: 'Not signed in yet' };
}

/**
 * The last run's status; a run skipped because its creator must sign in says so (not "still running"). `short` (the
 * list, where the Runs as column already says "Needs sign-in"): just "Skipped".
 */
export function lastRunView(
  s: Pick<ScheduleItem, 'lastStatus' | 'runsAs'>,
  { short = false }: { short?: boolean } = {},
): { tone: StatusTone; label: string } {
  if (s.lastStatus === 'skipped') {
    if (signInView(s.runsAs)) return { tone: 'warn', label: short ? 'Skipped' : 'Skipped (needs sign-in)' };
    if (short) return { tone: 'neutral', label: 'Skipped' };
  }
  return runStatusView(s.lastStatus);
}

/** Where the Entra sign-in for a schedule comes back to: its page, which then says it worked (`signedIn=1`). */
export const scheduleSignInReturn = (key: string) => `/schedules/${encodeURIComponent(key)}?signedIn=1`;

/**
 * POST /auth/schedule-consent: the Entra sign-in that lets a schedule use its creator's own access (only the creator).
 * Returns where the browser goes next.
 */
export async function scheduleSignInUrl(key: string, returnTo: string): Promise<string> {
  const { redirect } = await api(`/auth/schedule-consent?returnTo=${encodeURIComponent(returnTo)}`, {
    method: 'POST',
    body: { key },
    schema: RedirectResponse,
  });
  return redirect;
}

/** GET /api/schedules/identities: who schedules may run as here (app identity names; creators' own access). */
export const scheduleIdentitiesQuery = queryOptions({
  queryKey: ['schedules', 'identities'] as const,
  queryFn: ({ signal }) =>
    api('/api/schedules/identities', {
      schema: parser((input) => {
        const o = rec(input);
        return {
          apps: arr(o.apps).filter((x): x is string => typeof x === 'string'),
          user: bool(o.user) ?? false,
        };
      }),
      signal,
    }),
  staleTime: 5 * 60_000,
});

/** An email list or Teams channel, by configuration key name. */
export interface ScheduleTarget {
  type: 'email' | 'teams';
  key: string;
  label: string;
}

export type ScheduleDelivery =
  { type: 'file'; format: string; retain: number | null } | (ScheduleTarget & { format: string | null });

function readTarget(raw: unknown): ScheduleTarget | null {
  const o = rec(raw);
  const key = pick(o, 'key');
  if ((o.type !== 'email' && o.type !== 'teams') || !key) return null;
  return { type: o.type, key, label: pick(o, 'label') ?? key };
}

function readDelivery(raw: unknown): ScheduleDelivery | null {
  const o = rec(raw);
  if (o.type === 'file')
    return { type: 'file', format: pick(o, 'format') ?? 'xlsx', retain: num(o.retain) ?? null };
  const target = readTarget(o);
  return target ? { ...target, format: pick(o, 'format') ?? null } : null;
}

export function readSchedule(raw: unknown): ScheduleItem | null {
  const o = rec(raw);
  const key = pick(o, 'key', 'id');
  const cron = pick(o, 'cron');
  if (!key || !cron) return null;
  const job = rec(o.job);
  const approved = o.approvedBy;
  return {
    key,
    title: pick(o, 'title') ?? key,
    summary: pick(o, 'summary') ?? null,
    cron,
    cronText: pick(o, 'cronText') ?? null,
    timezone: pick(o, 'timezone') ?? 'UTC',
    enabled: bool(o.enabled) ?? false,
    identity: pick(o, 'identity') ?? 'automation',
    runsAs: readRunsAs(o.runsAs),
    job: {
      kind: pick(job, 'kind') ?? 'report',
      ref: pick(job, 'ref') ?? null,
      params: isRecord(job.params) ? job.params : null,
    },
    nextRunAt: pick(o, 'nextRunAt') ?? null,
    lastRunAt: pick(o, 'lastRunAt') ?? null,
    lastStatus: pick(o, 'lastStatus') ?? null,
    writeCapable: bool(o.writeCapable) ?? false,
    approvedBy:
      typeof approved === 'string'
        ? [approved]
        : arr(approved).filter((x): x is string => typeof x === 'string'),
    source: o.source === 'portal' ? 'portal' : 'content',
    pendingApprovalId: pick(o, 'pendingApprovalId', 'approvalId') ?? null,
    createdBy: pick(o, 'createdBy') ?? null,
    canManage: bool(o.canManage) ?? false,
    delivery: arr(o.delivery)
      .map(readDelivery)
      .filter((d): d is ScheduleDelivery => d !== null),
    notify: arr(o.notify)
      .map(readTarget)
      .filter((t): t is ScheduleTarget => t !== null),
  };
}

export const schedulesQuery = queryOptions({
  queryKey: ['schedules'] as const,
  queryFn: ({ signal }) => api('/api/schedules', { schema: listOf(readSchedule), signal }),
  refetchInterval: 60_000,
});

export interface ScheduleRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  runId: string | null;
  artifact: { name: string; href: string; size: number | null } | null;
  error: { message: string; code: string | null } | null;
  /** Skipped runs: why ("The previous run was still running …"). */
  reason: string | null;
}

/** A run's status in words; a skipped run says why in short when it is waiting for its creator to sign in. */
export function runView(r: Pick<ScheduleRun, 'status' | 'error'>): { tone: StatusTone; label: string } {
  if (r.status === 'skipped')
    return r.error?.code === 'needs_sign_in'
      ? { tone: 'warn', label: 'Skipped (needs sign-in)' }
      : { tone: 'neutral', label: 'Skipped' };
  return runStatusView(r.status);
}

export function readScheduleRun(raw: unknown): ScheduleRun | null {
  const o = rec(raw);
  const id = pick(o, 'id');
  if (!id) return null;
  const a = rec(o.artifact);
  const href = pick(a, 'href');
  const e = o.error;
  return {
    id,
    trigger: pick(o, 'trigger') ?? 'cron',
    status: pick(o, 'status') ?? 'queued',
    startedAt: pick(o, 'startedAt') ?? null,
    endedAt: pick(o, 'endedAt') ?? null,
    runId: pick(o, 'runId') ?? null,
    artifact: href
      ? { name: pick(a, 'name') ?? href.split('/').pop() ?? 'report', href, size: num(a.size) ?? null }
      : null,
    error:
      typeof e === 'string'
        ? { message: e, code: null }
        : pick(rec(e), 'message')
          ? { message: pick(rec(e), 'message')!, code: pick(rec(e), 'code') ?? null }
          : null,
    reason: pick(o, 'reason') ?? null,
  };
}

export const scheduleRunsPage = (key: string, cursor: string | null, signal?: AbortSignal) =>
  api(`/api/schedules/${encodeURIComponent(key)}/runs${query({ cursor })}`, {
    schema: listOf(readScheduleRun),
    signal,
  });

/** 202 → { approvalId }: the change waits for a second person. */
export const ToggleResponse = parser((input) => ({ approvalId: pick(rec(input), 'approvalId') ?? null }));

export async function setScheduleEnabled(
  key: string,
  enabled: boolean,
): Promise<{ approvalId: string | null }> {
  return api(`/api/schedules/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: { enabled },
    schema: ToggleResponse,
  });
}

export async function runScheduleNow(key: string): Promise<{ scheduleRunId: string | null }> {
  return api(`/api/schedules/${encodeURIComponent(key)}/run`, {
    method: 'POST',
    schema: parser((input) => ({ scheduleRunId: pick(rec(input), 'scheduleRunId', 'id') ?? null })),
  });
}

/** Removes a portal schedule (soft delete: its run history and files stay until retention). */
export async function deleteSchedule(key: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

/** Run outcomes in words, with their tone. */
export function runStatusView(status: string | null): { tone: StatusTone; label: string } {
  switch (status) {
    case 'succeeded':
    case 'ok':
    case 'success':
      return { tone: 'ok', label: 'Succeeded' };
    case 'failed':
    case 'error':
      return { tone: 'crit', label: 'Failed' };
    case 'running':
      return { tone: 'info', label: 'Running' };
    case 'queued':
    case 'pending':
      return { tone: 'neutral', label: 'Queued' };
    case 'skipped':
      return { tone: 'neutral', label: 'Skipped (still running)' };
    case 'timedOut':
    case 'timeout':
      return { tone: 'crit', label: 'Timed out' };
    case 'warn':
    case 'degraded':
      return { tone: 'warn', label: 'Completed with warnings' };
    case null:
      return { tone: 'neutral', label: 'Never run' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export const JOB_LABEL: Record<string, string> = {
  report: 'Report',
  playbook: 'Playbook',
  probe: 'Synthetic test',
  script: 'PowerShell script',
  contentHealth: 'Content health',
};

// ── Probes ─────────────────────────────────────────────────────────────────────────────────────────

export type ProbeStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface ProbePoint {
  ts: string;
  metric: number | null;
  status: ProbeStatus;
  message?: string | null;
}

export interface ProbeItem {
  key: string;
  title: string;
  kind: string;
  latest: (ProbePoint & { unit: string | null; message: string | null }) | null;
  series: ProbePoint[];
  thresholds: { warn: number | null; crit: number | null; unit: string | null; worse: 'higher' | 'lower' };
}

const asProbeStatus = (v: unknown): ProbeStatus =>
  v === 'ok' || v === 'warn' || v === 'crit'
    ? v
    : v === 'succeeded' || v === 'pass'
      ? 'ok'
      : v === 'failed' || v === 'fail'
        ? 'crit'
        : 'unknown';

function readPoint(raw: unknown): ProbePoint | null {
  const o = rec(raw);
  const ts = pick(o, 'ts', 'at', 'time');
  if (!ts) return null;
  return {
    ts,
    metric: num(o.metric) ?? num(o.value) ?? null,
    status: asProbeStatus(o.status),
    message: pick(o, 'message') ?? null,
  };
}

/** Which way is worse for a check kind's primary metric, and its unit (PROBE_METRICS in @adminforge/schemas). */
const LOWER_IS_WORSE = new Set(['certExpiry', 'appCredentialExpiry']);
const KIND_UNIT: Record<string, string> = {
  http: 'ms',
  graph: 'ms',
  arm: 'ms',
  tokenAcquisition: 'ms',
  dnsResolve: 'ms',
  functionHealth: 'ms',
  certExpiry: 'days',
  appCredentialExpiry: 'days',
  licenseThreshold: '%',
  signInHealth: '%',
};

export function readProbe(raw: unknown): ProbeItem | null {
  const o = rec(raw);
  const key = pick(o, 'key', 'id');
  if (!key) return null;
  const kind = pick(o, 'kind') ?? pick(rec(o.check), 'kind') ?? 'http';
  const latestRaw = o.latest ? rec(o.latest) : null;
  const latestPoint = latestRaw ? readPoint(latestRaw) : null;
  const t = rec(o.thresholds);
  return {
    key,
    title: pick(o, 'title') ?? key,
    kind,
    latest:
      latestPoint && latestRaw
        ? {
            ...latestPoint,
            unit: pick(latestRaw, 'unit') ?? null,
            message: pick(latestRaw, 'message') ?? null,
          }
        : null,
    series: arr(o.series)
      .map(readPoint)
      .filter((p): p is ProbePoint => !!p)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
    thresholds: {
      warn: num(t.warn) ?? null,
      crit: num(t.crit) ?? null,
      unit: pick(t, 'unit') ?? pick(latestRaw ?? {}, 'unit') ?? KIND_UNIT[kind] ?? null,
      worse: t.worse === 'lower' || (t.worse === undefined && LOWER_IS_WORSE.has(kind)) ? 'lower' : 'higher',
    },
  };
}

export const probesQuery = queryOptions({
  queryKey: ['probes'] as const,
  queryFn: ({ signal }) => api('/api/probes', { schema: listOf(readProbe), signal }),
  refetchInterval: 60_000,
});

export const probeResultsQuery = (key: string, since: string) =>
  queryOptions({
    queryKey: ['probes', key, 'results', since] as const,
    queryFn: ({ signal }) =>
      api(`/api/probes/${encodeURIComponent(key)}/results${query({ since })}`, {
        schema: listOf(readPoint),
        signal,
      }),
  });

export const PROBE_KIND_LABEL: Record<string, string> = {
  http: 'HTTP endpoints',
  graph: 'Microsoft Graph',
  arm: 'Azure Resource Manager',
  tokenAcquisition: 'Token acquisition',
  certExpiry: 'TLS certificates',
  dnsResolve: 'DNS records',
  functionHealth: 'Function apps',
  appCredentialExpiry: 'App credentials',
  licenseThreshold: 'Licence seats',
  signInHealth: 'Sign-in health',
  kql: 'Configuration checks (KQL)',
};

export const PROBE_TONE: Record<ProbeStatus, StatusTone> = {
  ok: 'ok',
  warn: 'warn',
  crit: 'crit',
  unknown: 'neutral',
};
export const PROBE_LABEL: Record<ProbeStatus, string> = {
  ok: 'Healthy',
  warn: 'Degraded',
  crit: 'Failing',
  unknown: 'No data',
};
