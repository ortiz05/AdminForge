import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Button,
  cn,
  DataTable,
  dataTable,
  formatRelative,
  formatTimestamp,
  Icon,
  IconButton,
  Kpi,
  KpiStrip,
  LockKeyIcon,
  PageHeader,
  StatusPill,
  TABLE_MUTED_TEXT,
  useNow,
  type DataColumn,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { useMe } from '../lib/session';
import { requiresText } from '../app/NavRail';
import { runStatusView } from '../ops/schedules';
import { useDocumentTitle } from '../ops/ui';
import {
  failingSchedules,
  filterReports,
  hasFilters,
  isScheduled,
  lastRunOf,
  reportsCatalogQuery,
  scheduleText,
  tagCounts,
  type ReportItem,
  type ScheduledFilter,
} from './catalog';
import { ReportDetails } from './ReportDetails';
import { ReportFilters, type FacetOption } from './ReportFilters';
import { filtersOf, joinList, splitList, type ReportsSearch } from './search';

/** Tags that repeat what the row already says (every row is a report; the area has its own column) go last. */
function orderedTags(r: ReportItem): string[] {
  const quiet = (t: string) => t === 'report' || t === r.area;
  return [...r.tags.filter((t) => !quiet(t)), ...r.tags.filter(quiet)];
}

function TagChips({
  report,
  active,
  onTag,
}: {
  report: ReportItem;
  active: string[];
  onTag: (tag: string) => void;
}) {
  const tags = orderedTags(report);
  // Up to two chips while they fit the column (about 16 characters); the rest is "+N" with the names in its title.
  const shown: string[] = [];
  let used = 0;
  for (const t of tags) {
    if (shown.length === 2 || (shown.length > 0 && used + t.length > 16)) break;
    shown.push(t);
    used += t.length;
  }
  const rest = tags.slice(shown.length);
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTag(t)}
          aria-pressed={active.includes(t)}
          aria-label={`Show reports tagged ${t}`}
          className={cn(
            'inline-flex h-5 min-w-0 shrink items-center rounded-sm border px-1.5 font-mono text-2xs text-fg-2',
            'transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:text-fg',
            active.includes(t) ? 'border-accent bg-accent-subtle text-accent' : 'border-line',
          )}
        >
          <span className="truncate">{t}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <span className={cn('shrink-0 text-xs', TABLE_MUTED_TEXT)} title={rest.join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/**
 * Reports: every report in one catalogue — search, area, tags and schedule state in the URL; details and the
 * schedule form open beside it (`?report=`, `?schedule=new`, `?edit=`), so links can be shared and Back closes them.
 */
export function ReportsPage({ search }: { search: ReportsSearch }) {
  const me = useMe();
  const operator = me.roles.includes('Portal.Operator');
  const navigate = useNavigate();
  const router = useRouter();
  const now = useNow(30_000);
  const q = useQuery(reportsCatalogQuery);
  useDocumentTitle('Reports');

  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const areas = useMemo(() => q.data?.areas ?? [], [q.data]);
  const areaIndex = useMemo(() => new Map(areas.map((a, i) => [a.key, i])), [areas]);
  const areaLabel = useCallback((key: string) => areas.find((a) => a.key === key)?.label ?? key, [areas]);
  const filters = filtersOf(search);
  const shown = useMemo(
    () =>
      filterReports(items, filters).sort(
        (a, b) =>
          (areaIndex.get(a.area) ?? 99) - (areaIndex.get(b.area) ?? 99) || a.title.localeCompare(b.title),
      ),
    // filtersOf builds a new object each render; its inputs are the search params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, areaIndex, search.q, search.area, search.tag, search.scheduled],
  );
  const filtered = hasFilters(filters);

  // Facet counts: areas over everything else that filters, tags over the current result (tags combine with "and").
  const areaOptions: FacetOption[] = useMemo(() => {
    const pool = filterReports(items, { ...filters, areas: [] });
    return areas
      .map((a) => ({ value: a.key, label: a.label, count: pool.filter((r) => r.area === a.key).length }))
      .filter((o) => o.count > 0 || filters.areas.includes(o.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, areas, search.q, search.area, search.tag, search.scheduled]);
  const tagOptions: FacetOption[] = useMemo(() => {
    const counted = tagCounts(shown).map((t) => ({ value: t.tag, label: t.tag, count: t.count }));
    const missing = filters.tags.filter((t) => !counted.some((c) => c.value === t));
    return [...counted, ...missing.map((t) => ({ value: t, label: t, count: 0 }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, search.tag]);

  // ── URL ──
  // Opening the panel or the form pushes a history entry (Back closes it); filters replace the current one. When
  // this page pushed the entry, closing goes back to it instead of adding another.
  const pushed = useRef({ report: false, form: false });
  useEffect(() => {
    if (!search.report) pushed.current.report = false;
    if (!search.schedule && !search.edit) pushed.current.form = false;
  }, [search.report, search.schedule, search.edit]);

  const setSearch = useCallback(
    (patch: Partial<ReportsSearch>, push = false) =>
      void navigate({
        to: '/reports',
        search: (prev: ReportsSearch) => ({ ...prev, ...patch }),
        replace: !push,
      }),
    [navigate],
  );
  const setFilters = useCallback(
    (patch: Partial<ReportsSearch>) => {
      // The entry the panel was pushed on now has other filters: closing replaces instead of going back.
      pushed.current.report = false;
      pushed.current.form = false;
      setSearch(patch);
    },
    [setSearch],
  );
  const openReport = (key: string) => {
    if (key === search.report) return;
    // Switching reports replaces the entry, so Back still closes the panel in one step.
    if (!search.report) pushed.current.report = true;
    setSearch({ report: key, schedule: undefined, edit: undefined }, !search.report);
  };
  const closeReport = () => {
    if (pushed.current.report && !search.schedule && !search.edit) router.history.back();
    else setSearch({ report: undefined, schedule: undefined, edit: undefined });
  };
  const openForm = (patch: Pick<ReportsSearch, 'schedule' | 'edit'>) => {
    pushed.current.form = true;
    setSearch({ schedule: undefined, edit: undefined, ...patch }, true);
  };
  const closeForm = () => {
    if (pushed.current.form) router.history.back();
    else setSearch({ schedule: undefined, edit: undefined });
  };
  const addTag = useCallback(
    (tag: string) => {
      const tags = splitList(search.tag);
      setFilters({ tag: joinList(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]) });
    },
    [search.tag, setFilters],
  );
  const onSearch = useCallback((value: string | undefined) => setFilters({ q: value }), [setFilters]);
  const clearFilters = () =>
    setFilters({ q: undefined, area: undefined, tag: undefined, scheduled: undefined });

  // ── KPIs ──
  const scheduledCount = items.filter(isScheduled).length;
  const failing = items.reduce((n, r) => n + failingSchedules(r).length, 0);
  const anySchedules = items.some((r) => r.schedules.length > 0);
  const unlicensed = items.filter((r) => r.badge).length;

  const columns = useMemo<DataColumn<ReportItem>[]>(
    () => [
      {
        id: 'report',
        header: 'Report',
        kind: 'text',
        value: (r) => r.title,
        cell: (r) => (
          <span className="flex min-w-0 items-center gap-3">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-fg-2 compact:size-6"
              aria-hidden
            >
              <Icon name={r.icon ?? areas.find((a) => a.key === r.area)?.icon ?? 'chart-bar'} size={15} />
            </span>
            <span className="flex min-w-0 flex-col leading-tight compact:flex-row compact:items-baseline compact:gap-2">
              <Link
                to="/reports"
                search={(prev: ReportsSearch) => ({
                  ...prev,
                  report: r.key,
                  schedule: undefined,
                  edit: undefined,
                })}
                onClick={() => {
                  if (!search.report) pushed.current.report = true;
                }}
                replace={Boolean(search.report)}
                // Compact rows put the title and key on one line: the title keeps up to 3/5 of it.
                className="truncate font-medium text-fg underline-offset-2 hover:underline compact:max-w-3/5 compact:shrink-0"
                title={r.title}
              >
                {r.title}
              </Link>
              <span className={cn('flex min-w-0 items-baseline gap-1.5 text-xs', TABLE_MUTED_TEXT)}>
                <span className="shrink-0 truncate font-mono text-2xs compact:shrink">{r.key}</span>
                {r.summary && (
                  <span className="truncate compact:hidden" title={r.summary}>
                    · {r.summary}
                  </span>
                )}
              </span>
            </span>
          </span>
        ),
        width: 'minmax(320px, 2.6fr)',
        filter: 'none',
        hideable: false,
      },
      {
        id: 'area',
        header: 'Area',
        kind: 'text',
        value: (r) => areaLabel(r.area),
        cell: (r) => <span className="truncate text-fg-2">{areaLabel(r.area)}</span>,
        width: 'minmax(110px, 0.7fr)',
        filter: 'none',
      },
      {
        id: 'tags',
        header: 'Tags',
        kind: 'text',
        value: (r) => orderedTags(r).join(' '),
        cell: (r) => <TagChips report={r} active={filters.tags} onTag={addTag} />,
        width: 'minmax(180px, 1.2fr)',
        filter: 'none',
        sortable: false,
      },
      {
        id: 'schedule',
        header: 'Schedule',
        kind: 'text',
        value: (r) => scheduleText(r).text,
        cell: (r) => {
          const t = scheduleText(r);
          return (
            <span className={cn('truncate', t.muted ? TABLE_MUTED_TEXT : 'text-fg-2')} title={t.text}>
              {t.text}
            </span>
          );
        },
        width: 'minmax(190px, 1.3fr)',
        filter: 'none',
      },
      {
        id: 'last',
        header: 'Last run',
        kind: 'status',
        value: (r) => {
          const last = lastRunOf(r);
          return last ? runStatusView(last.status) : null;
        },
        cell: (r) => {
          const last = lastRunOf(r);
          if (!last) return <span className={TABLE_MUTED_TEXT}>—</span>;
          const v = runStatusView(last.status);
          return (
            <span className="flex min-w-0 items-center gap-2">
              <StatusPill status={v.tone} size="sm">
                {v.label}
              </StatusPill>
              <time
                dateTime={last.at}
                title={formatTimestamp(last.at)}
                className={cn('truncate text-xs', TABLE_MUTED_TEXT)}
              >
                {formatRelative(last.at, now)}
              </time>
            </span>
          );
        },
        width: 'minmax(160px, 1fr)',
        filter: 'none',
      },
      {
        id: 'requires',
        header: 'Requirements',
        kind: 'text',
        value: (r) => r.badge ?? '',
        cell: (r) =>
          r.badge ? (
            <span
              className={cn(
                'inline-flex h-5 min-w-0 items-center gap-1 rounded-sm border border-line px-1.5 text-2xs font-medium',
                TABLE_MUTED_TEXT,
              )}
              title={r.badge}
            >
              <LockKeyIcon size={10} weight="bold" aria-hidden className="shrink-0" />
              <span className="truncate" aria-hidden>
                {requiresText(r.badge) ?? r.badge}
              </span>
              <span className="sr-only">{r.badge}</span>
            </span>
          ) : null,
        width: 'minmax(136px, 0.8fr)',
        filter: 'none',
      },
    ],
    [areas, areaLabel, filters.tags, addTag, now, search.report],
  );

  const selected = search.report ? items.find((r) => r.key === search.report) : undefined;
  // The form needs the report from the catalogue, the Operator role, and an export (or a schedule to edit).
  const formOpen = Boolean(
    selected && operator && (search.edit || (search.schedule === 'new' && selected.schedulable)),
  );
  const err = q.error;

  return (
    <>
      <PageHeader
        layout="list"
        eyebrow="Catalogue"
        title="Reports"
        description="Every report in AdminForge. Open one to see what it covers, run it now, or schedule it to be delivered as a file, by email or to Teams."
        actions={
          <IconButton
            label="Refresh"
            icon={<ArrowClockwiseIcon size={16} />}
            onClick={() => void q.refetch()}
          />
        }
      />
      <div className="flex flex-col gap-6">
        <KpiStrip label="Report summary" className="xl:grid-cols-4">
          <Kpi
            variant="cell"
            label="Reports"
            value={q.isPending ? null : items.length}
            hint={`in ${new Set(items.map((r) => r.area)).size} areas`}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Scheduled"
            value={q.isPending ? null : scheduledCount}
            hint={`of ${items.length} reports`}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Failing schedules"
            value={q.isPending ? null : failing}
            status={
              !anySchedules
                ? undefined
                : failing
                  ? { tone: 'crit', label: 'Last run failed' }
                  : { tone: 'ok', label: 'All passing' }
            }
            hint={anySchedules ? undefined : 'nothing scheduled yet'}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Need a licence"
            value={q.isPending ? null : unlicensed}
            hint="not licensed in this tenant"
            loading={q.isPending}
          />
        </KpiStrip>

        <div className="flex min-w-0 flex-col">
          {/* The table's own toolbar slot (padding and rhythm), so the filters line up with its columns. */}
          <div className={dataTable().toolbar()}>
            <ReportFilters
              q={search.q}
              areas={{ options: areaOptions, selected: filters.areas }}
              tags={{ options: tagOptions, selected: filters.tags }}
              scheduled={search.scheduled}
              onSearch={onSearch}
              onAreas={(a) => setFilters({ area: joinList(a) })}
              onTags={(t) => setFilters({ tag: joinList(t) })}
              onScheduled={(scheduled: ScheduledFilter | undefined) => setFilters({ scheduled })}
              onClear={clearFilters}
              count={
                q.isSuccess
                  ? shown.length === items.length
                    ? `${items.length} reports`
                    : `${shown.length} of ${items.length} reports`
                  : null
              }
            />
          </div>
          <DataTable
            label="Reports"
            data={shown}
            columns={columns}
            getRowId={(r) => r.key}
            toolbar={false}
            loading={q.isPending}
            maxHeight={640}
            activeRowId={search.report}
            onRowActivate={(r) => openReport(r.key)}
            rowLabel={(r) => r.title}
            error={
              err
                ? {
                    title: 'Reports didn’t load',
                    message: err.message,
                    hint: err instanceof ApiRequestError ? err.hint : undefined,
                    code: err instanceof ApiRequestError ? err.code : undefined,
                    correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
                    onRetry: () => void q.refetch(),
                  }
                : null
            }
            empty={
              filtered
                ? {
                    title: 'No reports match these filters',
                    description: 'Remove a tag or an area, or change the search.',
                    action: (
                      <Button size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ),
                  }
                : {
                    title: 'No reports you can open',
                    description:
                      'Reports appear here once they are published and your roles allow them. Ask a Portal Admin if you expected some.',
                  }
            }
          />
        </div>
      </div>

      <ReportDetails
        reportKey={search.report}
        known={selected}
        areaLabel={areaLabel}
        catalogPending={q.isPending}
        operator={operator}
        now={now}
        form={formOpen ? { editKey: search.edit } : null}
        onClose={closeReport}
        onSchedule={() => openForm({ schedule: 'new' })}
        onEdit={(key) => openForm({ edit: key })}
        onFormDone={closeForm}
        onFormCancel={closeForm}
        onTag={addTag}
        activeTags={filters.tags}
      />
    </>
  );
}
