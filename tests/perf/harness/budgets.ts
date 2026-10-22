/**
 * Budgets for the perf suite (tests/perf/budgets.json): a default every datasource must meet, and per-datasource
 * entries for the ones that don't yet — each with the reason (`knownSlow` / `knownError`) and its own ceilings, so a
 * known-slow datasource that gets slower still fails. `AF_PERF_RECORD=1 pnpm test:perf` rewrites the file from a run
 * (keeping reasons already written, adding the survey's reasons for new entries); fixes shrink or remove entries.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Measure, Status } from './run-datasources';

export interface Budget {
  maxRequests?: number;
  maxBytes?: number;
  maxTransformMs?: number;
  maxHeapPeakMB?: number;
  maxEstimatedLiveMs?: number;
  /** Too slow or too big at enterprise scale today, and why (fix it, then delete the entry). */
  knownSlow?: string;
  /** Fails at enterprise scale today, and why (the status it fails with is `expect`). */
  knownError?: string;
  expect?: Status;
  /** A `paging: all` crawl that stops at maxItems with more data left (results silently cut). */
  knownTruncated?: string;
  /**
   * Its transform runs close to the engine's 250 ms budget (wall clock), so on a busy machine it can time out: a
   * transform timeout is accepted instead of failing the suite. Recorded for transforms over half the budget.
   */
  mayTimeOut?: boolean;
}

const isTransformTimeout = (m: Measure) =>
  m.code === 'content_error' && /timed out after \d+ ms/.test(m.message ?? '');

/** Improvements worth acting on (not failures): known errors that now succeed. */
export function notes(m: Measure, b: BudgetsFile): string[] {
  const entry = b.datasources[m.key];
  return entry?.knownError && m.status === 'ok'
    ? [`now succeeds — its knownError entry can go (${entry.knownError})`]
    : [];
}

export interface BudgetsFile {
  scale: string;
  liveLatencyMs: number;
  default: Required<
    Pick<Budget, 'maxRequests' | 'maxBytes' | 'maxTransformMs' | 'maxHeapPeakMB' | 'maxEstimatedLiveMs'>
  >;
  datasources: Record<string, Budget>;
}

export const BUDGETS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'budgets.json');

/** Sources the fake doesn't serve (Azure, the PowerShell runner's live mode): `unmodelled` is expected for them. */
const NOT_GRAPH = new Set(['arm', 'resourceGraph', 'logAnalytics', 'function']);

export function loadBudgets(): BudgetsFile {
  return JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) as BudgetsFile;
}

/** Problems of one measure against its budget (empty = within budget). */
export function check(m: Measure, b: BudgetsFile): string[] {
  const entry = b.datasources[m.key];
  const limits = { ...b.default, ...entry };
  const out: string[] = [];
  const expected = entry?.expect ?? 'ok';
  if (m.status === 'unmodelled') {
    if (!NOT_GRAPH.has(m.source) && expected !== 'unmodelled')
      out.push(
        `calls a Graph path the synthetic tenant doesn't model (${m.message}) — add it to tests/perf/graph/fake-graph.ts`,
      );
  } else if (m.status === 'error' || m.status === 'timeout') {
    if (!entry?.knownError && !(entry?.mayTimeOut && isTransformTimeout(m)))
      out.push(`${m.status}: ${m.code} — ${m.message}`);
  }
  if (m.truncated && !entry?.knownTruncated)
    out.push(
      `crawl stopped at maxItems (${m.maxItems ?? 'default'}) with more data left: results are silently cut`,
    );
  if (m.requests > limits.maxRequests) out.push(`${m.requests} requests > ${limits.maxRequests}`);
  if (m.bytes > limits.maxBytes)
    out.push(`${(m.bytes / 1e6).toFixed(1)} MB > ${(limits.maxBytes / 1e6).toFixed(1)} MB`);
  if (m.status === 'ok' && m.transformMs > limits.maxTransformMs)
    out.push(`transform ${m.transformMs} ms > ${limits.maxTransformMs} ms`);
  if (m.heapPeakMB > limits.maxHeapPeakMB) out.push(`heap +${m.heapPeakMB} MB > ${limits.maxHeapPeakMB} MB`);
  if (m.estimatedLiveMs > limits.maxEstimatedLiveMs)
    out.push(
      `≈${(m.estimatedLiveMs / 1000).toFixed(1)} s live > ${(limits.maxEstimatedLiveMs / 1000).toFixed(1)} s`,
    );
  return out;
}

/** Why a datasource is slow at enterprise scale, from the 2026-10-17 data-loading survey (docs/performance.md). */
const SURVEY: Array<[RegExp, string]> = [
  [
    /^identity\.inactive-users#/,
    'reads every member at 120 per page (signInActivity) and maps/sorts all rows in the transform; needs a tenant-wide snapshot or server-side signInActivity filters',
  ],
  [
    /^identity\.health#stale/,
    'crawls up to 50k users at 120 per page for two KPIs; needs a snapshot or /users/$count',
  ],
  [
    /^identity\.health#credentials/,
    'flattens every application credential in the transform; needs a snapshot',
  ],
  [
    /^identity\.health#guestGrowth/,
    'reads every guest and counts per month in the transform; 12 /users/$count sub-requests would do',
  ],
  [
    /^m365\.licence#users/,
    'selects signInActivity (120 per page) across every holder of the SKU and filters in the transform; needs cursor paging with server-side $filter/$search',
  ],
  [/^identity\.password-policies#/, 'every member with a per-row transform'],
  [/^identity\.groups-without-owners#membership/, 'every group with $expand=members plus a transform'],
  [
    /^identity\.app-registrations#apps/,
    'every app with $expand=owners, facets and sort in the transform; needs cursor paging and owners/$count',
  ],
  [/^m365\.teams#teams/, 'every team with $expand=owners, search in the transform'],
  [/^m365\.dashboard#teams/, 'crawls every team for three KPIs'],
  [/^identity\.users-without-mfa#/, 'transform and sort over every registration row'],
  [
    /^endpoint\.(stale-devices|os-versions|device-security-gaps|non-compliant-devices|autopilot-not-enrolled)#/,
    'every managed/Entra device with a per-row transform; needs Intune report exports or untransformed rows',
  ],
  [
    /^m365\.(inactive-licensed-users|mailbox-storage|onedrive-usage|sharepoint-site-usage|teams-activity|sharepoint-sites)#/,
    'usage report detail rows (one per user/site) through a transform; stream untransformed rows, KPIs from the *Counts reports',
  ],
  [
    /^identity\.app-credential-(hygiene|expiry)#|^identity\.app-registration-risks#/,
    'every app/service principal credential flattened in the transform; needs a snapshot',
  ],
  [
    /^identity\.directory-changes#|^identity\.adminforge-group-changes#/,
    'a 20k cap over 7 days of audit events is exceeded in a large tenant; transform over all rows',
  ],
  [
    /^identity\.(consent-grants|app-permissions)#/,
    'every grant/app role assignment; getByIds covers only the first 1,000 ids',
  ],
  [/^identity\.inactive-guests#/, 'every guest with a per-row transform'],
  [/^identity\.disabled-users-with-licences#/, 'transform over every disabled user'],
  [/^security\.risky-users/, 'risk detections through a deep transform'],
  [/^endpoint\.apps#apps/, 'every app with $expand=assignments, search in the transform'],
  [/^m365\.message-center-actions#/, 'every message through a transform'],
];
const surveyReason = (key: string) => SURVEY.find(([re]) => re.test(key))?.[1];

const up = (n: number, factor: number, plus: number) => Math.ceil(n * factor + plus);

/** A budgets file recorded from `measures`, keeping reasons already in `previous`. */
export function record(measures: Measure[], previous: BudgetsFile): BudgetsFile {
  const datasources: Record<string, Budget> = {};
  const day = new Date().toISOString().slice(0, 10);
  for (const m of measures) {
    const prev = previous.datasources[m.key];
    const bad =
      m.status === 'error' ||
      m.status === 'timeout' ||
      (m.status === 'unmodelled' && !NOT_GRAPH.has(m.source));
    const over =
      m.requests > previous.default.maxRequests ||
      m.bytes > previous.default.maxBytes ||
      (m.status === 'ok' && m.transformMs > previous.default.maxTransformMs) ||
      m.heapPeakMB > previous.default.maxHeapPeakMB ||
      m.estimatedLiveMs > previous.default.maxEstimatedLiveMs;
    const borderline = m.status === 'ok' && m.transformMs > previous.default.maxTransformMs / 2;
    if (!bad && !over && !m.truncated && !borderline) continue;
    const reason =
      prev?.knownSlow ??
      prev?.knownError ??
      surveyReason(m.key) ??
      `measured ${day} at ${previous.scale} scale`;
    const e: Budget = {};
    if (bad) {
      e.knownError = prev?.knownError ?? `${m.code}: ${reason}`;
      e.expect = m.status;
    } else e.knownSlow = reason;
    if (m.truncated)
      e.knownTruncated =
        prev?.knownTruncated ?? `stops at maxItems ${m.maxItems ?? '(default 5000)'}: ${reason}`;
    if (m.requests > previous.default.maxRequests) e.maxRequests = up(m.requests, 1.25, 2);
    if (m.bytes > previous.default.maxBytes) e.maxBytes = up(m.bytes, 1.5, 0);
    if (m.status === 'ok' && m.transformMs > previous.default.maxTransformMs)
      e.maxTransformMs = up(m.transformMs, 2, 100);
    if (borderline || isTransformTimeout(m)) e.mayTimeOut = true;
    if (m.heapPeakMB > previous.default.maxHeapPeakMB) e.maxHeapPeakMB = up(m.heapPeakMB, 1.5, 64);
    if (m.estimatedLiveMs > previous.default.maxEstimatedLiveMs)
      e.maxEstimatedLiveMs = up(m.estimatedLiveMs, 1.5, 1000);
    datasources[m.key] = e;
  }
  return {
    ...previous,
    datasources: Object.fromEntries(Object.entries(datasources).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function writeBudgets(b: BudgetsFile): void {
  writeFileSync(BUDGETS_FILE, `${JSON.stringify(b, null, 2)}\n`);
}
