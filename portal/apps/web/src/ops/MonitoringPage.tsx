import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Button,
  cn,
  EmptyState,
  FilterBar,
  formatRelative,
  IconButton,
  Kpi,
  KpiStrip,
  PageHeader,
  Panel,
  SegmentedControl,
  Skeleton,
  Sparkline,
  STATUS_ICON,
  StatusPill,
  useNow,
} from '@adminforge/ui';
import {
  PROBE_KIND_LABEL,
  PROBE_LABEL,
  PROBE_TONE,
  probesQuery,
  schedulesQuery,
  type ProbeItem,
  type ProbeStatus,
} from './schedules';
import { useNav } from '../lib/session';
import { QueryError, useDocumentTitle } from './ui';
import { formatMetric, MetricValue, passRate, severity, thresholdText, TONE_TEXT } from './probe-format';
import { ProbeDetail } from './ProbeDetail';
import { HealthTimeline } from './HealthTimeline';
import { MonitoringSchedules } from './MonitoringSchedules';
import {
  facetCounts,
  failingSchedules,
  FUNCTIONS,
  OTHER_SERVICE,
  probeMatches,
  scheduleMatches,
  splitList,
  statusOf,
  type MonitoringFilters,
} from './monitoring-model';

export interface MonitoringSearch {
  probe?: string;
  /** Only what warns or fails: checks degraded or failing, schedules whose last run did. */
  show?: 'all' | 'problems';
  /** Services, comma-separated (probe `group`s: navigation section keys, `platform`); `?group=exchange` is one service. */
  group?: string;
  /** Functions (`FUNCTIONS` in monitoring-model), comma-separated. */
  fn?: string;
  /** Tags, comma-separated: an item carrying any of them. */
  tag?: string;
  /** Text in a title, key, summary, latest message or tag. */
  q?: string;
  /** Group the tiles by check type instead of by service. */
  by?: 'check';
}

/** Probes without a `group`. */
const OTHER_GROUP = { key: 'other', label: 'Other checks', icon: 'pulse' };

function ProbeTile({
  p,
  now,
  onOpen,
  context,
}: {
  p: ProbeItem;
  now: number;
  onOpen: () => void;
  /** What kind of check it is (grouped by service) or which service it watches (grouped by check type). */
  context?: string;
}) {
  const status = statusOf(p);
  const tone = PROBE_TONE[status];
  const metrics = p.series.map((x) => x.metric).filter((m): m is number => m !== null);
  const unit = p.latest?.unit ?? p.thresholds.unit;
  const threshold = thresholdText(p);
  const rate = passRate(p);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex min-w-0 flex-col gap-3 rounded-(--af-panel-radius) border bg-panel p-4 text-left transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:bg-raised',
        status === 'crit' ? 'border-crit/50' : status === 'warn' ? 'border-warn/50' : 'border-line',
      )}
      aria-label={`${p.title}: ${PROBE_LABEL[status]}${p.latest ? `, ${formatMetric(p.latest.metric, unit)}` : ''}. Open details.`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          {context && <span className="af-eyebrow truncate">{context}</span>}
          <span className="text-sm font-medium text-fg group-hover:underline">{p.title}</span>
        </span>
        <StatusPill status={tone} size="sm" className="shrink-0">
          {PROBE_LABEL[status]}
        </StatusPill>
      </span>
      <span className="flex items-end justify-between gap-3">
        <MetricValue value={p.latest?.metric} unit={unit} />
        {metrics.length > 1 && (
          <Sparkline
            data={metrics}
            label={`${p.title}: last ${metrics.length} results`}
            width={112}
            height={30}
            className="mb-0.5"
          />
        )}
      </span>
      <span className="flex flex-col gap-0.5 text-xs text-fg-3">
        {threshold && <span className="font-mono text-2xs">{threshold}</span>}
        {/* The time is never cut: the pass rate wraps to the next line instead. */}
        <span className="flex flex-wrap gap-x-1">
          <span className="whitespace-nowrap">
            {p.latest ? `checked ${formatRelative(p.latest.ts, now)}` : 'not checked yet'}
          </span>
          {rate && <span className="whitespace-nowrap">· {rate}</span>}
        </span>
        {p.latest?.message && status !== 'ok' && (
          <span className={cn('line-clamp-2 break-words', TONE_TEXT[tone])} title={p.latest.message}>
            {p.latest.message}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Monitoring (Overview › Monitoring): the health of everything AdminForge watches. Health checks and synthetic
 * transactions as tiles grouped by service (or check type), worst first; the last 24 hours hour by hour; and the
 * schedules that run reports, automations and sweeps with their last run. One filter bar narrows all of it by service,
 * function, tag, problems and text, kept in the URL. `?group=<key>` is one service's checks — the status mark at the
 * end of each service's section row in the navigation links there.
 */
export function MonitoringPage({ search }: { search: MonitoringSearch }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const q = useQuery(probesQuery);
  const sq = useQuery(schedulesQuery);
  const nav = useNav();
  const show = search.show ?? 'all';
  const filters = useMemo<MonitoringFilters>(
    () => ({
      services: splitList(search.group),
      functions: splitList(search.fn),
      tags: splitList(search.tag),
      text: search.q ?? '',
      problems: search.show === 'problems',
    }),
    [search.group, search.fn, search.tag, search.q, search.show],
  );
  const oneService = filters.services.length === 1 ? filters.services[0] : undefined;
  // One service on its own is grouped by check (its own section heading would only repeat the eyebrow).
  const byCheck = search.by === 'check' || !!oneService;
  const services = useMemo(() => {
    const m = new Map((q.data?.groups ?? []).map((g) => [g.key, g]));
    m.set(OTHER_GROUP.key, OTHER_GROUP);
    return m;
  }, [q.data]);
  // The service's name comes from the checks, else from the navigation (a section without checks yet).
  const serviceLabel = useCallback(
    (key: string) =>
      services.get(key)?.label ??
      nav.data?.sections.find((sec) => sec.key === key)?.label ??
      (key === 'platform' ? 'AdminForge' : key),
    [services, nav.data],
  );
  /** The service a check watches, or undefined when it names none ("Other checks" is a heading, not a service). */
  const serviceOf = (p: ProbeItem) => (p.group ? serviceLabel(p.group) : undefined);
  const focus = oneService ? serviceLabel(oneService) : undefined;
  useDocumentTitle(focus ? `Monitoring · ${focus}` : 'Monitoring');
  const allProbes = useMemo(() => q.data?.items ?? [], [q.data]);
  const allSchedules = useMemo(() => sq.data?.items ?? [], [sq.data]);
  // The key figures and the last 24 hours cover everything the other filters let through; "Problems" only narrows
  // the lists below.
  const scope = useMemo(() => ({ ...filters, problems: false }), [filters]);
  const probes = useMemo(() => allProbes.filter((p) => probeMatches(p, scope)), [allProbes, scope]);
  const scheduled = useMemo(
    () => allSchedules.filter((s) => scheduleMatches(s, scope, allProbes)),
    [allSchedules, scope, allProbes],
  );
  const visible = useMemo(() => allProbes.filter((p) => probeMatches(p, filters)), [allProbes, filters]);
  const visibleSchedules = useMemo(
    () => allSchedules.filter((s) => scheduleMatches(s, filters, allProbes)),
    [allSchedules, filters, allProbes],
  );
  const counts = { ok: 0, warn: 0, crit: 0, unknown: 0 } as Record<ProbeStatus, number>;
  for (const p of probes) counts[statusOf(p)]++;
  const failing = failingSchedules(scheduled).length;
  const enabledCount = scheduled.filter((s) => s.enabled).length;
  const order = useMemo(() => [...services.keys()], [services]);
  const groupsOf = useCallback(
    (list: readonly ProbeItem[]) => {
      const by = new Map<string, ProbeItem[]>();
      const keyOf = (p: ProbeItem) => (byCheck ? p.kind : (p.group ?? OTHER_GROUP.key));
      for (const p of list) by.set(keyOf(p), [...(by.get(keyOf(p)) ?? []), p]);
      const labelOf = (key: string) =>
        byCheck ? (PROBE_KIND_LABEL[key] ?? key) : (services.get(key) ?? OTHER_GROUP).label;
      const rank = (key: string) =>
        byCheck ? 0 : order.indexOf(key) < 0 ? order.length : order.indexOf(key);
      return [...by.entries()]
        .map(([key, items]) => ({
          key,
          label: labelOf(key),
          items: items.sort((a, b) => severity(b) - severity(a) || a.title.localeCompare(b.title)),
        }))
        .sort(
          (a, b) =>
            Math.max(...b.items.map(severity)) - Math.max(...a.items.map(severity)) ||
            rank(a.key) - rank(b.key) ||
            a.label.localeCompare(b.label),
        );
    },
    [byCheck, services, order],
  );
  const groups = useMemo(() => groupsOf(visible), [groupsOf, visible]);
  const timelineRows = useMemo(
    () => groupsOf(probes).map((g) => ({ key: g.key, label: g.label, probes: g.items })),
    [groupsOf, probes],
  );
  const facetData = useMemo(() => facetCounts(allProbes, allSchedules), [allProbes, allSchedules]);
  const facets = useMemo(
    () => [
      {
        id: 'service',
        label: 'Service',
        options: [...facetData.services.entries()]
          .sort(([a], [b]) => {
            const ra = order.indexOf(a) < 0 ? order.length : order.indexOf(a);
            const rb = order.indexOf(b) < 0 ? order.length : order.indexOf(b);
            return ra - rb || a.localeCompare(b);
          })
          .map(([value, count]) => ({
            value,
            label: value === OTHER_SERVICE ? OTHER_GROUP.label : serviceLabel(value),
            count,
          })),
      },
      {
        id: 'function',
        label: 'Function',
        options: FUNCTIONS.filter((f) => facetData.functions.has(f.key)).map((f) => ({
          value: f.key,
          label: f.label,
          count: facetData.functions.get(f.key),
        })),
      },
      {
        id: 'tag',
        label: 'Tag',
        options: [...facetData.tags.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([value, count]) => ({ value, count })),
      },
    ],
    [facetData, order, serviceLabel],
  );
  const PARAM = { service: 'group', function: 'fn', tag: 'tag' } as const;
  const selected = search.probe ? allProbes.find((p) => p.key === search.probe) : undefined;
  const setSearch = (patch: Partial<MonitoringSearch>) =>
    void navigate({
      to: '/monitoring',
      search: (prev: MonitoringSearch) => ({ ...prev, ...patch }),
      replace: true,
    });
  const filtered = !!(search.group || search.fn || search.tag || search.q);
  const clearFilters = () =>
    setSearch({
      group: undefined,
      fn: undefined,
      tag: undefined,
      q: undefined,
      show: undefined,
      probe: undefined,
    });
  const clearButton = (
    <Button size="sm" intent="secondary" onClick={clearFilters}>
      Clear filters
    </Button>
  );
  const notLoaded = 'didn’t load — see below';
  const allHealthy = probes.length > 0 && counts.ok === probes.length;
  const schedulesEmpty =
    filtered || filters.problems
      ? filtered
        ? {
            title: 'No schedules match',
            description: 'Clear a filter to see more.',
            action: clearButton,
          }
        : { title: 'No schedule needs a look', description: 'Every schedule that’s on passed its last run.' }
      : { title: 'No schedules yet', description: 'Schedule a report from its page in Reports.' };

  return (
    <>
      <PageHeader
        eyebrow={focus ?? 'Overview'}
        title="Monitoring"
        description={
          focus
            ? `Health checks, synthetic transactions and schedules of ${focus}, run as the automation identity.`
            : 'The health of everything AdminForge watches: health checks and synthetic transactions of Microsoft 365, Azure and AdminForge itself, and the schedules that run reports and automations.'
        }
        actions={
          <IconButton
            label="Refresh"
            icon={<ArrowClockwiseIcon size={16} />}
            onClick={() => {
              void q.refetch();
              void sq.refetch();
            }}
          />
        }
      />
      <div className="flex flex-col gap-8">
        <FilterBar
          facets={facets}
          values={{ service: filters.services, function: filters.functions, tag: filters.tags }}
          onValuesChange={(id, values) =>
            setSearch({
              [PARAM[id as keyof typeof PARAM]]: values.length ? values.join(',') : undefined,
              probe: undefined,
            })
          }
          search={search.q ?? ''}
          onSearchChange={(v) => setSearch({ q: v.trim() ? v.slice(0, 100) : undefined })}
          searchPlaceholder="Search checks and schedules…"
          onClear={filtered ? clearFilters : undefined}
        >
          <SegmentedControl
            aria-label="Show"
            value={show}
            onValueChange={(v) => setSearch({ show: v === 'problems' ? 'problems' : undefined })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'problems', label: 'Problems' },
            ]}
          />
        </FilterBar>
        <KpiStrip label="Health" className="xl:grid-cols-5">
          <Kpi
            variant="cell"
            label="Healthy checks"
            value={q.isError ? null : counts.ok}
            {...(q.isError
              ? { hint: notLoaded }
              : {
                  status: {
                    tone: allHealthy ? 'ok' : 'neutral',
                    label: `of ${probes.length} ${probes.length === 1 ? 'check' : 'checks'}`,
                  },
                })}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Degraded"
            value={q.isError ? null : counts.warn}
            {...(q.isError
              ? { hint: notLoaded }
              : { status: { tone: counts.warn ? 'warn' : 'neutral', label: 'over warning' } })}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Failing"
            value={q.isError ? null : counts.crit}
            {...(q.isError
              ? { hint: notLoaded }
              : { status: { tone: counts.crit ? 'crit' : 'neutral', label: 'failed or critical' } })}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="No data"
            value={q.isError ? null : counts.unknown}
            hint={q.isError ? notLoaded : 'not run yet'}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            className="col-span-2 xl:col-span-1"
            label="Failed last run"
            value={sq.isError ? null : failing}
            {...(sq.isError
              ? { hint: notLoaded }
              : enabledCount === 0
                ? { hint: 'no schedules turned on' }
                : {
                    status: failing
                      ? { tone: 'crit' as const, label: `of ${enabledCount} turned on` }
                      : { tone: 'ok' as const, label: `all ${enabledCount} passing` },
                  })}
            loading={sq.isPending}
          />
        </KpiStrip>
        {!q.isPending && !q.isError && probes.length > 0 && <HealthTimeline rows={timelineRows} now={now} />}
        <section aria-labelledby="monitoring-checks" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="monitoring-checks" className="text-md font-semibold text-fg">
              Health checks <span className="font-normal text-fg-3">· {visible.length}</span>
            </h2>
            {!oneService && (
              <SegmentedControl
                aria-label="Group checks by"
                value={byCheck ? 'check' : 'service'}
                onValueChange={(v) => setSearch({ by: v === 'check' ? 'check' : undefined })}
                options={[
                  { value: 'service', label: 'By service' },
                  { value: 'check', label: 'By check' },
                ]}
              />
            )}
          </div>
          {q.isError ? (
            <Panel>
              <QueryError title="Checks didn’t load" error={q.error} onRetry={() => void q.refetch()} />
            </Panel>
          ) : q.isPending ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-busy="true">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} shape="block" className="h-36" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <Panel>
              {allProbes.length === 0 ? (
                <EmptyState title="No checks yet">
                  Add one with{' '}
                  <code className="font-mono text-xs">
                    pnpm adminforge new probe {oneService ?? '<section>'}/&lt;name&gt;
                  </code>
                  , then schedule it.
                </EmptyState>
              ) : probes.length === 0 &&
                focus &&
                filters.functions.length + filters.tags.length === 0 &&
                !filters.text ? (
                <EmptyState title={`No checks for ${focus} yet`}>
                  Add one with{' '}
                  <code className="font-mono text-xs">
                    pnpm adminforge new probe {oneService}/&lt;name&gt;
                  </code>
                  , then schedule it.
                </EmptyState>
              ) : probes.length === 0 ? (
                <EmptyState title="No checks match" action={clearButton}>
                  Clear a filter to see more.
                </EmptyState>
              ) : (
                <EmptyState title="Nothing is degraded or failing">
                  Every check that has run is healthy.
                </EmptyState>
              )}
            </Panel>
          ) : (
            // Groups flow into columns (worst group first), so one check of a kind doesn't take a whole row.
            <div className="columns-1 gap-6 md:columns-2 xl:columns-3 2xl:columns-4">
              {groups.map((g) => {
                const worst = g.items[0] ? statusOf(g.items[0]) : 'unknown';
                const Glyph = STATUS_ICON[PROBE_TONE[worst]];
                return (
                  <section
                    key={g.key}
                    aria-labelledby={`probes-${g.key}`}
                    className="mb-6 flex break-inside-avoid flex-col gap-3"
                  >
                    <h3
                      id={`probes-${g.key}`}
                      className="flex items-center gap-2 text-sm font-semibold text-fg"
                    >
                      <Glyph size={15} weight="fill" aria-hidden className={TONE_TEXT[PROBE_TONE[worst]]} />
                      {g.label}{' '}
                      <span className="font-normal text-fg-3">
                        · {g.items.length}
                        <span className="sr-only"> {g.items.length === 1 ? 'check' : 'checks'}</span>
                      </span>
                    </h3>
                    {g.items.map((p) => (
                      <ProbeTile
                        key={p.key}
                        p={p}
                        now={now}
                        context={byCheck && !oneService ? serviceOf(p) : undefined}
                        onOpen={() => setSearch({ probe: p.key })}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </section>
        <section aria-labelledby="monitoring-schedules" className="flex flex-col gap-4">
          <h2 id="monitoring-schedules" className="text-md font-semibold text-fg">
            Schedules and reports <span className="font-normal text-fg-3">· {visibleSchedules.length}</span>
          </h2>
          {sq.isError ? (
            <Panel>
              <QueryError title="Schedules didn’t load" error={sq.error} onRetry={() => void sq.refetch()} />
            </Panel>
          ) : (
            <MonitoringSchedules
              items={visibleSchedules}
              probes={q.isError ? null : allProbes}
              serviceLabel={serviceLabel}
              now={now}
              loading={sq.isPending}
              empty={schedulesEmpty}
            />
          )}
        </section>
      </div>
      {selected && (
        <ProbeDetail
          key={selected.key}
          p={selected}
          service={serviceOf(selected)}
          onClose={() => setSearch({ probe: undefined })}
        />
      )}
    </>
  );
}
