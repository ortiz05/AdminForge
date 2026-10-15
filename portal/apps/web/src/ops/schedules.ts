import { queryOptions } from '@tanstack/react-query';
import type { StatusTone } from '@adminforge/ui';
import { api } from '../lib/api';
import { arr, bool, listOf, num, parser, pick, query, rec } from '../runs/json';

/**
 * Schedules and synthetic probes (R6, ADR-011) — built against the scheduler contract:
 *   GET   /api/schedules                      → { items: Schedule[] }
 *   PATCH /api/schedules/:key { enabled }     → 200 (done) | 202 { approvalId } (write-capable: second person must approve)
 *   POST  /api/schedules/:key/run             → { scheduleRunId }
 *   GET   /api/schedules/:key/runs?cursor=    → { items: ScheduleRun[], cursor? }
 *   GET   /api/probes                         → { items: Probe[] }
 *   GET   /api/probes/:key/results?since=     → { items: ProbePoint[] }
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
  identity: 'automation';
  job: { kind: JobKind | string; ref: string | null };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: boolean;
  approvedBy: string[];
  source: 'content' | 'portal';
  /** Set while an enable request waits for its second approver. */
  pendingApprovalId: string | null;
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
    identity: 'automation',
    job: { kind: pick(job, 'kind') ?? 'report', ref: pick(job, 'ref') ?? null },
    nextRunAt: pick(o, 'nextRunAt') ?? null,
    lastRunAt: pick(o, 'lastRunAt') ?? null,
    lastStatus: pick(o, 'lastStatus') ?? null,
    writeCapable: bool(o.writeCapable) ?? false,
    approvedBy: typeof approved === 'string' ? [approved] : arr(approved).filter((x): x is string => typeof x === 'string'),
    source: o.source === 'portal' ? 'portal' : 'content',
    pendingApprovalId: pick(o, 'pendingApprovalId', 'approvalId') ?? null,
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
    artifact: href ? { name: pick(a, 'name') ?? href.split('/').pop() ?? 'report', href, size: num(a.size) ?? null } : null,
    error:
      typeof e === 'string'
        ? { message: e, code: null }
        : pick(rec(e), 'message')
          ? { message: pick(rec(e), 'message')!, code: pick(rec(e), 'code') ?? null }
          : null,
  };
}

export const scheduleRunsPage = (key: string, cursor: string | null, signal?: AbortSignal) =>
  api(`/api/schedules/${encodeURIComponent(key)}/runs${query({ cursor })}`, { schema: listOf(readScheduleRun), signal });

/** 202 → { approvalId }: the change waits for a second person. */
export const ToggleResponse = parser((input) => ({ approvalId: pick(rec(input), 'approvalId') ?? null }));

export async function setScheduleEnabled(key: string, enabled: boolean): Promise<{ approvalId: string | null }> {
  return api(`/api/schedules/${encodeURIComponent(key)}`, { method: 'PATCH', body: { enabled }, schema: ToggleResponse });
}

export async function runScheduleNow(key: string): Promise<{ scheduleRunId: string | null }> {
  return api(`/api/schedules/${encodeURIComponent(key)}/run`, {
    method: 'POST',
    schema: parser((input) => ({ scheduleRunId: pick(rec(input), 'scheduleRunId', 'id') ?? null })),
  });
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
  v === 'ok' || v === 'warn' || v === 'crit' ? v : v === 'succeeded' || v === 'pass' ? 'ok' : v === 'failed' || v === 'fail' ? 'crit' : 'unknown';

function readPoint(raw: unknown): ProbePoint | null {
  const o = rec(raw);
  const ts = pick(o, 'ts', 'at', 'time');
  if (!ts) return null;
  return { ts, metric: num(o.metric) ?? num(o.value) ?? null, status: asProbeStatus(o.status), message: pick(o, 'message') ?? null };
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
    latest: latestPoint && latestRaw ? { ...latestPoint, unit: pick(latestRaw, 'unit') ?? null, message: pick(latestRaw, 'message') ?? null } : null,
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

export const PROBE_TONE: Record<ProbeStatus, StatusTone> = { ok: 'ok', warn: 'warn', crit: 'crit', unknown: 'neutral' };
export const PROBE_LABEL: Record<ProbeStatus, string> = { ok: 'Healthy', warn: 'Degraded', crit: 'Failing', unknown: 'No data' };
