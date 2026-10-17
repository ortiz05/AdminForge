import { queryOptions } from '@tanstack/react-query';
import { api, isRecord } from '../lib/api';
import { arr, bool, num, parser, pick, rec } from '../runs/json';
import { cadenceProblem, cronFor, type Cadence, type CronParts } from '../ops/cadence';
import { describeCron } from '../ops/cron';
import { readSchedule, runStatusView, type ScheduleItem, type ScheduleTarget } from '../ops/schedules';

/**
 * The report catalogue (/reports) — built against the API contract:
 *   GET    /api/reports                        → { items: ReportItem[], areas: ReportArea[] }   (Portal.Reader)
 *   GET    /api/reports/:key                   → ReportItem & { columns }                       (Portal.Reader)
 *   GET    /api/schedules/delivery-options     → { email: { available, lists }, teams: { lists } } (Portal.Operator)
 *   POST   /api/schedules                      → 201 ScheduleItem   (a portal report schedule; Portal.Operator)
 *   PUT    /api/schedules/:key                 → ScheduleItem       (same body; `canManage`)
 * Edit/delete/enable/run-now of existing schedules use ops/schedules.ts.
 */

export interface ReportRequires {
  licences: string[];
  entraRoles: string[];
  portalRoles: string[];
  /** Permissions by API ("graph", "arm", …). */
  scopes: Record<string, string[]>;
}

export type ParamValue = string | number | boolean;

export interface ReportParam {
  name: string;
  type: string;
  label: string;
  description: string | null;
  /** Literal defaults only (expression defaults are null). */
  default: unknown;
  required: boolean;
  multiple: boolean;
  values: Array<{ value: ParamValue; label: string }> | null;
  min: number | null;
  max: number | null;
  /** Can be set on a schedule (string, number, boolean, enum without a picker); others keep their default. */
  schedulable: boolean;
}

export interface ScheduleSummary {
  key: string;
  title: string;
  cron: string;
  cronText: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  source: 'content' | 'portal';
  createdBy: string | null;
  canManage: boolean;
  pendingApprovalId: string | null;
}

export interface ReportItem {
  key: string;
  title: string;
  summary: string | null;
  tags: string[];
  owner: string;
  version: string;
  /** First segment of the key: identity, m365, endpoint, security, azure. */
  area: string;
  icon: string | null;
  href: string;
  requires: ReportRequires;
  /** "Requires Entra P1" when this tenant lacks a declared licence. */
  badge: string | null;
  exportFormats: string[];
  schedulable: boolean;
  params: ReportParam[];
  schedules: ScheduleSummary[];
}

export interface ReportArea {
  key: string;
  label: string;
  icon: string;
}

export interface ReportCatalog {
  items: ReportItem[];
  areas: ReportArea[];
}

export interface ReportDetail extends ReportItem {
  /** What an export contains. */
  columns: Array<{ field: string; label: string }>;
}

export interface DeliveryOptions {
  email: { available: boolean; lists: Array<{ key: string; label: string }> };
  teams: { lists: Array<{ key: string; label: string }> };
}

// ── Readers ────────────────────────────────────────────────────────────────────────────────────────

const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const isParamValue = (v: unknown): v is ParamValue =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

function readParam(raw: unknown): ReportParam | null {
  const o = rec(raw);
  const name = pick(o, 'name');
  if (!name) return null;
  const values = Array.isArray(o.values)
    ? o.values.flatMap((v) => {
        const opt = rec(v);
        if (isParamValue(opt.value))
          return [{ value: opt.value, label: pick(opt, 'label') ?? String(opt.value) }];
        return isParamValue(v) ? [{ value: v, label: String(v) }] : [];
      })
    : null;
  return {
    name,
    type: pick(o, 'type') ?? 'string',
    label: pick(o, 'label') ?? name,
    description: pick(o, 'description') ?? null,
    default: o.default ?? null,
    required: bool(o.required) ?? false,
    multiple: bool(o.multiple) ?? false,
    values,
    min: num(o.min) ?? null,
    max: num(o.max) ?? null,
    schedulable: bool(o.schedulable) ?? false,
  };
}

function readSummary(raw: unknown): ScheduleSummary | null {
  const o = rec(raw);
  const key = pick(o, 'key');
  const cron = pick(o, 'cron');
  if (!key || !cron) return null;
  return {
    key,
    title: pick(o, 'title') ?? key,
    cron,
    cronText: pick(o, 'cronText') ?? null,
    timezone: pick(o, 'timezone') ?? 'UTC',
    enabled: bool(o.enabled) ?? false,
    nextRunAt: pick(o, 'nextRunAt') ?? null,
    lastRunAt: pick(o, 'lastRunAt') ?? null,
    lastStatus: pick(o, 'lastStatus') ?? null,
    source: o.source === 'portal' ? 'portal' : 'content',
    createdBy: pick(o, 'createdBy') ?? null,
    canManage: bool(o.canManage) ?? false,
    pendingApprovalId: pick(o, 'pendingApprovalId') ?? null,
  };
}

export function readReport(raw: unknown): ReportItem | null {
  const o = rec(raw);
  const key = pick(o, 'key');
  if (!key) return null;
  const req = rec(o.requires);
  const scopes = Object.fromEntries(
    Object.entries(rec(req.scopes))
      .map(([api, list]) => [api, strings(list)] as const)
      .filter(([, list]) => list.length > 0),
  );
  const exportFormats = strings(o.exportFormats);
  return {
    key,
    title: pick(o, 'title') ?? key,
    summary: pick(o, 'summary') ?? null,
    tags: strings(o.tags),
    owner: pick(o, 'owner') ?? '',
    version: pick(o, 'version') ?? '',
    area: pick(o, 'area') ?? key.split('.')[0] ?? 'other',
    icon: pick(o, 'icon') ?? null,
    href: pick(o, 'href') ?? `/p/${key}`,
    requires: {
      licences: strings(req.licences),
      entraRoles: strings(req.entraRoles),
      portalRoles: strings(req.portalRoles),
      scopes,
    },
    badge: pick(o, 'badge') ?? null,
    exportFormats,
    schedulable: bool(o.schedulable) ?? exportFormats.length > 0,
    params: arr(o.params)
      .map(readParam)
      .filter((p): p is ReportParam => p !== null),
    schedules: arr(o.schedules)
      .map(readSummary)
      .filter((s): s is ScheduleSummary => s !== null),
  };
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export const ReportCatalogResponse = parser((input): ReportCatalog => {
  const o = rec(input);
  if (!Array.isArray(o.items)) throw new TypeError('Expected { items: [] }');
  const items = o.items.map(readReport).filter((r): r is ReportItem => r !== null);
  const areas = arr(o.areas).flatMap((a) => {
    const x = rec(a);
    const key = pick(x, 'key');
    return key
      ? [{ key, label: pick(x, 'label') ?? capitalise(key), icon: pick(x, 'icon') ?? 'folder' }]
      : [];
  });
  // An area the server didn't describe still gets a label (and keeps the server's order otherwise).
  for (const r of items)
    if (!areas.some((a) => a.key === r.area))
      areas.push({ key: r.area, label: capitalise(r.area), icon: 'folder' });
  return { items, areas };
});

export const ReportDetailResponse = parser((input): ReportDetail => {
  const report = readReport(input);
  if (!report) throw new TypeError('Expected a report');
  const columns = arr(rec(input).columns).flatMap((c) => {
    const x = rec(c);
    const field = pick(x, 'field');
    return field ? [{ field, label: pick(x, 'label') ?? field }] : [];
  });
  return { ...report, columns };
});

export const DeliveryOptionsResponse = parser((input): DeliveryOptions => {
  const o = rec(input);
  const lists = (v: unknown) =>
    arr(rec(v).lists).flatMap((l) => {
      const x = rec(l);
      const key = pick(x, 'key');
      return key ? [{ key, label: pick(x, 'label') ?? key }] : [];
    });
  return {
    email: { available: bool(rec(o.email).available) ?? false, lists: lists(o.email) },
    teams: { lists: lists(o.teams) },
  };
});

// ── Queries and mutations ──────────────────────────────────────────────────────────────────────────

export const reportsCatalogQuery = queryOptions({
  queryKey: ['reports', 'catalog'] as const,
  queryFn: ({ signal }) => api('/api/reports', { schema: ReportCatalogResponse, signal }),
  refetchInterval: 60_000,
});

export const reportDetailQuery = (key: string) =>
  queryOptions({
    queryKey: ['reports', 'detail', key] as const,
    queryFn: ({ signal }) =>
      api(`/api/reports/${encodeURIComponent(key)}`, { schema: ReportDetailResponse, signal }),
    staleTime: 60_000,
  });

export const deliveryOptionsQuery = queryOptions({
  queryKey: ['schedules', 'delivery-options'] as const,
  queryFn: ({ signal }) =>
    api('/api/schedules/delivery-options', { schema: DeliveryOptionsResponse, signal }),
  staleTime: 5 * 60_000,
});

export type ReportFormat = 'xlsx' | 'csv' | 'json';

export interface ReportScheduleRequest {
  title: string;
  cron: string;
  timezone: string;
  job: {
    kind: 'report';
    ref: string;
    params?: Record<string, unknown>;
    format: ReportFormat;
    retain?: number;
    emailKey?: string;
    teamsKey?: string;
  };
  notifyOnFailure?: { emailKey?: string; teamsKey?: string };
}

const ScheduleResponse = parser((input) => readSchedule(input));

/** POST (new) or PUT (edit) a portal report schedule. */
export function saveReportSchedule(body: ReportScheduleRequest, key?: string): Promise<ScheduleItem | null> {
  return key
    ? api(`/api/schedules/${encodeURIComponent(key)}`, { method: 'PUT', body, schema: ScheduleResponse })
    : api('/api/schedules', { method: 'POST', body, schema: ScheduleResponse });
}

// ── Catalogue logic (pure) ─────────────────────────────────────────────────────────────────────────

export type ScheduledFilter = 'yes' | 'no';

export interface ReportFilters {
  q?: string;
  areas: string[];
  tags: string[];
  scheduled?: ScheduledFilter;
}

export const enabledSchedules = (r: ReportItem) => r.schedules.filter((s) => s.enabled);
export const isScheduled = (r: ReportItem) => r.schedules.some((s) => s.enabled);
export const failingSchedules = (r: ReportItem) =>
  r.schedules.filter((s) => runStatusView(s.lastStatus).tone === 'crit');

/** Every search word must appear in the title, summary, a tag or the key. */
export function matchesSearch(r: ReportItem, q: string | undefined): boolean {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [r.title, r.summary ?? '', r.key, ...r.tags].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Search, areas (any of), tags (all of) and scheduled state. */
export function filterReports(items: readonly ReportItem[], f: ReportFilters): ReportItem[] {
  return items.filter(
    (r) =>
      matchesSearch(r, f.q) &&
      (f.areas.length === 0 || f.areas.includes(r.area)) &&
      f.tags.every((t) => r.tags.includes(t)) &&
      (!f.scheduled || (f.scheduled === 'yes') === isScheduled(r)),
  );
}

export const hasFilters = (f: ReportFilters) =>
  Boolean(f.q?.trim() || f.areas.length || f.tags.length || f.scheduled);

/** Tag → number of reports carrying it, most used first (then A→Z). */
export function tagCounts(items: readonly ReportItem[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of items) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The cadence in English with the browser's clock (the API's `cronText` is 24-hour), always naming the zone. */
export const cadenceText = (s: Pick<ScheduleSummary, 'cron' | 'cronText' | 'timezone'>) => {
  const text = describeCron(s.cron, s.timezone);
  return text.startsWith('Custom:') && s.cronText ? s.cronText : text;
};

/** The Schedule column: the cadence of the one enabled schedule, a count, "1 paused", or "Not scheduled". */
export function scheduleText(r: ReportItem): { text: string; muted: boolean } {
  const on = enabledSchedules(r);
  if (on.length === 1) return { text: cadenceText(on[0]!), muted: false };
  if (on.length > 1) return { text: `${on.length} schedules`, muted: false };
  if (r.schedules.length > 0) return { text: `${r.schedules.length} paused`, muted: true };
  return { text: 'Not scheduled', muted: true };
}

/** The most recent run across the report's schedules. */
export function lastRunOf(r: ReportItem): { status: string | null; at: string } | null {
  const ran = r.schedules.filter((s) => s.lastRunAt);
  if (!ran.length) return null;
  const latest = ran.reduce((a, b) => (Date.parse(b.lastRunAt!) > Date.parse(a.lastRunAt!) ? b : a));
  return { status: latest.lastStatus, at: latest.lastRunAt! };
}

// ── Schedule form (pure) ───────────────────────────────────────────────────────────────────────────

/** Cadences offered for reports: at most hourly (the API refuses anything more frequent). */
export const REPORT_CADENCES: readonly Cadence[] = [
  'hourly',
  'hours',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'monthlyWeekday',
  'english',
  'custom',
];

const CADENCE_WORD: Record<Cadence, string> = {
  minutes: 'every few minutes',
  hourly: 'hourly',
  hours: 'every few hours',
  daily: 'daily',
  weekdays: 'weekdays',
  weekly: 'weekly',
  monthly: 'monthly',
  monthlyWeekday: 'monthly',
  english: 'scheduled',
  custom: 'scheduled',
};

/** "Inactive users, weekly" — the name a new schedule gets until someone types one. */
export const defaultScheduleTitle = (report: Pick<ReportItem, 'title'>, cadence: Cadence) =>
  `${report.title}, ${CADENCE_WORD[cadence]}`;

/** Formats a schedule can write: the report's export formats (Excel, CSV) plus JSON. */
export function formatsFor(report: Pick<ReportItem, 'exportFormats'>): ReportFormat[] {
  const out = (['xlsx', 'csv'] as const).filter((f) => report.exportFormats.includes(f));
  return [...out, 'json'];
}

export interface ScheduleFormState {
  title: string;
  /** Someone typed a name: it no longer follows the cadence. */
  titleEdited: boolean;
  cron: CronParts;
  timezone: string;
  params: Record<string, unknown>;
  format: ReportFormat;
  retain: string;
  emailKey: string;
  teamsKey: string;
  alertEmailKey: string;
  alertTeamsKey: string;
}

/** A param's starting value: its literal default, else empty ([] for multi-select, false for a switch). */
export function paramDefault(p: ReportParam): unknown {
  if (p.default !== null && p.default !== undefined) return p.default;
  if (p.type === 'enum' && p.multiple) return [];
  if (p.type === 'boolean') return false;
  return '';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: unknown) =>
  v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Only what differs from the report's defaults is sent; the rest follows the report if its defaults change. */
export function changedParams(
  params: readonly ReportParam[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (!p.schedulable || !(p.name in values)) continue;
    let v = values[p.name];
    if (p.type === 'number' && typeof v === 'string') v = v.trim() === '' ? '' : Number(v);
    if (empty(v) && (p.default === null || p.default === undefined)) continue;
    if (same(v, p.default)) continue;
    out[p.name] = v;
  }
  return out;
}

/** Problems the form can catch before sending (the server still validates everything). */
export function formIssues(
  report: Pick<ReportItem, 'params'>,
  form: ScheduleFormState,
): Record<string, string> {
  const issues: Record<string, string> = {};
  const title = form.title.trim();
  if (!title) issues.title = 'Give the schedule a name.';
  else if (title.length > 120) issues.title = 'Keep the name to 120 characters.';
  const retain = Number(form.retain);
  if (!Number.isInteger(retain) || retain < 1 || retain > 1000)
    issues.retain = 'Enter a whole number from 1 to 1000.';
  // The API refuses report schedules that run more than once an hour; the field says so first.
  const cadence = cadenceProblem(form.cron, { hourlyOnly: true });
  if (cadence) issues.cron = cadence;
  else if (!cronFor(form.cron)) issues.cron = 'Enter a cron expression.';
  for (const p of report.params) {
    if (!p.schedulable) continue;
    const v = form.params[p.name];
    if (p.required && empty(v)) issues[`param.${p.name}`] = `${p.label} is required.`;
    if (p.type === 'number' && !empty(v)) {
      const n = Number(v);
      if (!Number.isFinite(n)) issues[`param.${p.name}`] = 'Enter a number.';
      else if (p.min !== null && n < p.min) issues[`param.${p.name}`] = `Enter ${p.min} or more.`;
      else if (p.max !== null && n > p.max) issues[`param.${p.name}`] = `Enter ${p.max} or less.`;
    }
  }
  return issues;
}

/** The POST / PUT body for the form. */
export function scheduleRequest(
  report: Pick<ReportItem, 'key' | 'params'>,
  form: ScheduleFormState,
): ReportScheduleRequest {
  const params = changedParams(report.params, form.params);
  const notify = {
    ...(form.alertEmailKey ? { emailKey: form.alertEmailKey } : {}),
    ...(form.alertTeamsKey ? { teamsKey: form.alertTeamsKey } : {}),
  };
  return {
    title: form.title.trim(),
    cron: cronFor(form.cron),
    timezone: form.timezone,
    job: {
      kind: 'report',
      ref: report.key,
      ...(Object.keys(params).length ? { params } : {}),
      format: form.format,
      retain: Number(form.retain),
      ...(form.emailKey ? { emailKey: form.emailKey } : {}),
      ...(form.teamsKey ? { teamsKey: form.teamsKey } : {}),
    },
    ...(Object.keys(notify).length ? { notifyOnFailure: notify } : {}),
  };
}

/** The values an edited schedule starts from: its own, falling back to the report's defaults. */
export function formValuesFromSchedule(
  report: Pick<ReportItem, 'params' | 'exportFormats'>,
  s: ScheduleItem,
): Pick<
  ScheduleFormState,
  'params' | 'format' | 'retain' | 'emailKey' | 'teamsKey' | 'alertEmailKey' | 'alertTeamsKey'
> {
  let file: { format: string; retain: number | null } | undefined;
  let email: (ScheduleTarget & { format: string | null }) | undefined;
  let teams: ScheduleTarget | undefined;
  for (const d of s.delivery) {
    if (d.type === 'file') file ??= d;
    else if (d.type === 'email') email ??= d;
    else teams ??= d;
  }
  const formats = formatsFor(report);
  const format = (file?.format ?? email?.format ?? formats[0]) as ReportFormat;
  const saved = isRecord(s.job.params) ? s.job.params : {};
  return {
    params: Object.fromEntries(
      report.params.map((p) => [p.name, p.name in saved ? saved[p.name] : paramDefault(p)]),
    ),
    format: formats.includes(format) ? format : formats[0]!,
    retain: String(file?.retain ?? 26),
    emailKey: email?.key ?? '',
    teamsKey: teams?.key ?? '',
    alertEmailKey: s.notify.find((n) => n.type === 'email')?.key ?? '',
    alertTeamsKey: s.notify.find((n) => n.type === 'teams')?.key ?? '',
  };
}

/** "Excel", "CSV", "JSON". */
export const FORMAT_LABEL: Record<string, string> = { xlsx: 'Excel', csv: 'CSV', json: 'JSON' };

/** Shown for a param the form doesn't set: its default in words. */
export function paramDefaultText(p: ReportParam): string {
  const d = p.default;
  if (d === null || d === undefined || d === '') return 'Not set';
  const label = (v: unknown) => p.values?.find((o) => o.value === v)?.label ?? String(v);
  if (Array.isArray(d)) return d.length ? d.map(label).join(', ') : 'None';
  if (typeof d === 'boolean') return d ? 'Yes' : 'No';
  if (typeof d === 'object') return 'Set by the report';
  return label(d);
}
