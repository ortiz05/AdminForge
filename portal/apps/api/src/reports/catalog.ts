import type {
  Navigation,
  Param,
  Params,
  PortalRole,
  ReportArea,
  ReportCatalogItem,
  ReportCatalogResponse,
  ReportDetailResponse,
  ReportParamInfo,
  ScheduleSummary,
} from '@adminforge/schemas';
import { hasRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { missingLicences, requiresBadge, type TenantLicences } from '../capabilities/licences';
import type { LoadedPage } from '../datasources/executor';
import { definitionNotFound } from '../definitions/registry';
import type { DefinitionRecord, DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import type { ScheduleItem } from '../schedules/service';
import { planExport } from './export';

/**
 * The Reports catalogue (GET /api/reports, /api/reports/:key): every report the caller may open, with what it needs,
 * its params (as the schedule form shows them), its export and the schedules that run it. Pure functions over the
 * registry, the tenant's licences and the schedules list; routes/report-catalog.ts wires them.
 */

type ReportDef = LoadedPage['def'] & {
  nav?: { icon?: string };
  export?: { formats: string[] };
  area?: string;
};

const SCHEDULABLE_TYPES = new Set(['string', 'number', 'boolean', 'enum']);
const INACTIVE = new Set(['draft', 'retired']);

/** A default the form can show: literals only (an expression is evaluated when the report runs). */
const literal = (v: unknown) => (v === undefined || (typeof v === 'string' && v.includes('${')) ? null : v);

/**
 * Whether a schedule may set this param: string, number, boolean or enum, not hidden and without an entity picker.
 * Others (pickers, dates, ids, hidden params, the query builder's filter) always run with the report's default, so a
 * schedule can't point a report that reads with application permissions at objects of its creator's choosing.
 */
export const isSchedulableParam = (p: Param): boolean =>
  !p.hidden && SCHEDULABLE_TYPES.has(p.type) && !(p.type === 'string' && p.picker);

/** How a `redact: true` param's value is shown (audit records, schedule items, report files). */
export const REDACTED = '[redacted]';

/** `params` with the values of params declared `redact: true` replaced by REDACTED. */
export function maskRedacted(
  params: Record<string, unknown>,
  declared: Readonly<Record<string, { redact?: boolean }>> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      declared && Object.hasOwn(declared, k) && declared[k]?.redact ? REDACTED : v,
    ]),
  );
}

/** Params as the schedule form shows them (hidden params omitted). */
export function reportParams(params: Params | undefined): ReportParamInfo[] {
  return Object.entries(params ?? {})
    .filter(([, p]) => !p.hidden)
    .map(([name, p]: [string, Param]) => ({
      name,
      type: p.type,
      label: p.label ?? name,
      description: p.description ?? null,
      default: literal(p.default),
      required: p.required === true,
      multiple: 'multiple' in p && p.multiple === true,
      values:
        p.type === 'enum'
          ? p.values.map((v) =>
              typeof v === 'object' ? { value: v.value, label: v.label } : { value: v, label: String(v) },
            )
          : null,
      min: p.type === 'number' ? (p.min ?? null) : null,
      max: p.type === 'number' ? (p.max ?? null) : null,
      schedulable: isSchedulableParam(p),
    }));
}

/** Scopes per resource; Entra-secured connections flatten to `connections.<id>`. */
function scopesOf(scopes: Record<string, unknown> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [resource, value] of Object.entries(scopes ?? {})) {
    if (Array.isArray(value)) out[resource] = value.map(String);
    else if (value && typeof value === 'object')
      for (const [id, list] of Object.entries(value as Record<string, unknown>))
        if (Array.isArray(list)) out[`${resource}.${id}`] = list.map(String);
  }
  return out;
}

/** The catalogue area: the report's `area` (a navigation section key), else its key's first segment. */
export const reportArea = (key: string, area?: string) => area ?? key.split('.')[0] ?? key;

/** Whether the caller holds every role in `requires.portalRoles` (the rule pages, exports and nav apply). */
export const mayOpen = (
  session: Pick<SessionRecord, 'roles'>,
  def: { requires?: { portalRoles?: PortalRole[] } },
) => (def.requires?.portalRoles ?? []).every((r) => hasRole(session, r));

const isActive = (def: { status?: string }) => !INACTIVE.has(def.status ?? 'active');

export const scheduleSummary = (s: ScheduleItem): ScheduleSummary => ({
  key: s.key,
  title: s.title,
  cron: s.cron,
  cronText: s.cronText,
  timezone: s.timezone,
  enabled: s.enabled,
  nextRunAt: s.nextRunAt,
  lastRunAt: s.lastRunAt,
  lastStatus: s.lastStatus,
  source: s.source,
  createdBy: s.createdBy,
  canManage: s.canManage,
  pendingApprovalId: s.pendingApprovalId,
  runsAs: s.runsAs,
});

/** Report key → schedules running it (content and portal). */
export function schedulesByReport(items: readonly ScheduleItem[]): Map<string, ScheduleSummary[]> {
  const out = new Map<string, ScheduleSummary[]>();
  for (const s of items)
    if (s.job.kind === 'report' && s.job.ref)
      out.set(s.job.ref, [...(out.get(s.job.ref) ?? []), scheduleSummary(s)]);
  return out;
}

export function catalogItem(
  rec: Pick<DefinitionRecord, 'key' | 'version' | 'def'>,
  opts: { licences: TenantLicences | null; schedules: ScheduleSummary[] },
): ReportCatalogItem {
  const def = rec.def as ReportDef;
  const r = def.requires ?? {};
  const missing = missingLicences(opts.licences, r.licences);
  return {
    key: rec.key,
    title: def.title,
    summary: def.summary ?? null,
    tags: def.tags ?? [],
    owner: def.owner,
    version: rec.version,
    area: reportArea(rec.key, def.area),
    icon: def.nav?.icon ?? null,
    href: `/p/${rec.key}`,
    requires: {
      licences: r.licences ?? [],
      entraRoles: r.entraRoles ?? [],
      portalRoles: r.portalRoles ?? [],
      scopes: scopesOf(r.scopes as Record<string, unknown> | undefined),
    },
    badge: missing?.length ? requiresBadge(missing) : null,
    exportFormats: def.export?.formats ?? [],
    schedulable: !!def.export,
    params: reportParams(def.params),
    schedules: opts.schedules,
  };
}

/** Areas present, in navigation order (label and icon of the navigation section with the same key). */
export function catalogAreas(navigation: Navigation | undefined, present: Iterable<string>): ReportArea[] {
  const keys = new Set(present);
  const sections = (navigation?.sections ?? [])
    .map((s, index) => ({ s, index }))
    .sort((a, b) => (a.s.order ?? 1000) - (b.s.order ?? 1000) || a.index - b.index)
    .map(({ s }) => s);
  const out: ReportArea[] = [];
  for (const s of sections)
    if (keys.has(s.key)) {
      out.push({ key: s.key, label: s.label, icon: s.icon });
      keys.delete(s.key);
    }
  for (const key of [...keys].sort())
    out.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), icon: 'folder' });
  return out;
}

export interface CatalogDeps {
  definitions: Pick<DefinitionSource, 'list' | 'get'>;
  /** Tenant licences as the caller sees them (null = unknown: nothing is badged). */
  licences: () => Promise<TenantLicences | null>;
  /** Every schedule the caller may see (ScheduleService.list with their session). */
  schedules: () => Promise<{ items: ScheduleItem[] }>;
  exportMaxRows: number;
}

async function navigationOf(definitions: CatalogDeps['definitions']): Promise<Navigation | undefined> {
  const navs = await definitions.list('navigation');
  return (navs.find((n) => n.key === 'portal.navigation') ?? navs[0])?.def as Navigation | undefined;
}

/** GET /api/reports */
export async function reportCatalog(
  deps: CatalogDeps,
  session: SessionRecord,
): Promise<ReportCatalogResponse> {
  const records = (await deps.definitions.list('report')).filter(
    (r) => isActive(r.def) && mayOpen(session, r.def as ReportDef),
  );
  const [licences, schedules, navigation] = await Promise.all([
    records.some((r) => r.def.requires?.licences?.length) ? deps.licences() : Promise.resolve(null),
    deps.schedules(),
    navigationOf(deps.definitions),
  ]);
  const byReport = schedulesByReport(schedules.items);
  const items = records
    .map((rec) => catalogItem(rec, { licences, schedules: byReport.get(rec.key) ?? [] }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  return {
    items,
    areas: catalogAreas(
      navigation,
      items.map((i) => i.area),
    ),
  };
}

/** GET /api/reports/:key — 404 when missing or inactive; 403 when the caller lacks one of its roles. */
export async function reportDetail(
  deps: CatalogDeps,
  session: SessionRecord,
  key: string,
): Promise<ReportDetailResponse> {
  const rec = await deps.definitions.get('report', key);
  if (!rec || rec.status === 'retired' || !isActive(rec.def)) throw definitionNotFound('report', key);
  const def = rec.def as ReportDef;
  if (!mayOpen(session, def))
    throw new AppError(
      403,
      'forbidden',
      `This report needs the ${def.requires!.portalRoles!.join(' and ')} role.`,
      {
        hint: 'Ask a portal administrator for access.',
      },
    );
  const [licences, schedules] = await Promise.all([
    def.requires?.licences?.length ? deps.licences() : Promise.resolve(null),
    deps.schedules(),
  ]);
  const item = catalogItem(rec, { licences, schedules: schedulesByReport(schedules.items).get(key) ?? [] });
  return { ...item, columns: await exportColumns(rec, deps.exportMaxRows) };
}

/** The columns an export of the report contains (the export planner's resolution, without the user's choice). */
async function exportColumns(
  rec: Pick<DefinitionRecord, 'key' | 'version' | 'sha256' | 'def'>,
  maxRows: number,
): Promise<Array<{ field: string; label: string }>> {
  const def = rec.def as ReportDef;
  const format = def.export?.formats[0];
  if (format !== 'csv' && format !== 'xlsx') return [];
  try {
    const page: LoadedPage = { def, version: rec.version, sha256: rec.sha256, kind: 'report', key: rec.key };
    const plan = await planExport(page, {}, format, { maxRows });
    return plan.columns.map((c) => ({ field: c.field, label: c.label }));
  } catch {
    return [];
  }
}
