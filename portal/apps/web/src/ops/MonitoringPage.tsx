import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Chart,
  cn,
  Drawer,
  EmptyState,
  formatNumber,
  formatRelative,
  formatTimestamp,
  IconButton,
  Kpi,
  KpiStrip,
  PageHeader,
  Panel,
  SegmentedControl,
  Skeleton,
  Sparkline,
  STATUS_ICON,
  STATUS_SEVERITY,
  StatusPill,
  useNow,
} from '@adminforge/ui';
import {
  PROBE_KIND_LABEL,
  PROBE_LABEL,
  PROBE_TONE,
  probeResultsQuery,
  probesQuery,
  type ProbeItem,
  type ProbeStatus,
} from './schedules';
import { Callout, Facts, QueryError, useDocumentTitle } from './ui';

export interface MonitoringSearch {
  probe?: string;
  show?: 'all' | 'problems';
}

const TONE_TEXT = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit', info: 'text-info', neutral: 'text-fg-3' } as const;
const DAY_MS = 86_400_000;

/** KQL checks report a column name as their unit (`nonCompliantResources`); show it as words. */
export function humanUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  if (/^(%|ms|s|days|rows|failures|GB|MB)$/.test(unit)) return unit;
  return unit.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

export function formatMetric(value: number | null | undefined, rawUnit: string | null): string {
  if (value === null || value === undefined) return '—';
  const n = Math.abs(value) >= 100 ? formatNumber(Math.round(value)) : formatNumber(Math.round(value * 10) / 10);
  const unit = humanUnit(rawUnit);
  if (!unit) return n;
  if (unit === '%') return `${n}%`;
  if (unit === 'days') return `${n} day${value === 1 ? '' : 's'}`;
  return `${n} ${unit}`;
}

export function thresholdText(p: ProbeItem): string | null {
  const { warn, crit, unit, worse } = p.thresholds;
  if (warn === null && crit === null) return null;
  const op = worse === 'higher' ? '≥' : '≤';
  return [warn !== null ? `warn ${op} ${formatMetric(warn, unit)}` : null, crit !== null ? `crit ${op} ${formatMetric(crit, unit)}` : null]
    .filter(Boolean)
    .join(' · ');
}

const statusOf = (p: ProbeItem): ProbeStatus => p.latest?.status ?? 'unknown';
const severity = (p: ProbeItem) => STATUS_SEVERITY[PROBE_TONE[statusOf(p)]];

function passRate(p: ProbeItem): string | null {
  const known = p.series.filter((x) => x.status !== 'unknown');
  if (known.length < 2) return null;
  const ok = known.filter((x) => x.status === 'ok').length;
  return `${ok} of ${known.length} checks healthy`;
}

/** Big number, small unit — long units (KQL column names) never dominate the tile. */
function MetricValue({ value, unit }: { value: number | null | undefined; unit: string | null }) {
  const number = formatMetric(value, null);
  const rest = formatMetric(value, unit).slice(number.length).trim();
  return (
    <span className="min-w-0 af-kpi-value text-2xl text-fg tabular-nums">
      {number}
      {rest && value !== null && value !== undefined && <span className="ml-1.5 text-sm font-medium text-fg-3">{rest}</span>}
    </span>
  );
}

function ProbeTile({ p, now, onOpen }: { p: ProbeItem; now: number; onOpen: () => void }) {
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
        <span className="min-w-0 text-sm font-medium text-fg group-hover:underline">{p.title}</span>
        <StatusPill status={tone} size="sm" className="shrink-0">
          {PROBE_LABEL[status]}
        </StatusPill>
      </span>
      <span className="flex items-end justify-between gap-3">
        <MetricValue value={p.latest?.metric} unit={unit} />
        {metrics.length > 1 && (
          <Sparkline data={metrics} label={`${p.title}: last ${metrics.length} results`} width={112} height={30} className="mb-0.5" />
        )}
      </span>
      <span className="flex flex-col gap-0.5 text-xs text-fg-3">
        {threshold && <span className="font-mono text-2xs">{threshold}</span>}
        <span className="truncate">
          {p.latest ? `checked ${formatRelative(p.latest.ts, now)}` : 'not checked yet'}
          {rate ? ` · ${rate}` : ''}
        </span>
        {p.latest?.message && status !== 'ok' && <span className={cn('truncate', TONE_TEXT[tone])}>{p.latest.message}</span>}
      </span>
    </button>
  );
}

function ProbeDetail({ p, onClose }: { p: ProbeItem; onClose: () => void }) {
  const now = useNow(60_000);
  // Rounded to 5 minutes so the query key (and the fetch) only changes every few minutes.
  const since = new Date(Math.floor((now - DAY_MS) / 300_000) * 300_000).toISOString();
  const q = useQuery(probeResultsQuery(p.key, since));
  const points = (q.data?.items.length ? q.data.items : p.series).slice(-288);
  const unit = p.latest?.unit ?? p.thresholds.unit;
  const status = statusOf(p);
  const failures = points.filter((x) => x.status === 'crit' || x.status === 'warn').slice(-8).reverse();
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      modal={false}
      docked
      className="w-160"
      eyebrow={PROBE_KIND_LABEL[p.kind] ?? p.kind}
      title={p.title}
      description={<StatusPill status={PROBE_TONE[status]}>{PROBE_LABEL[status]}</StatusPill>}
    >
      <div className="flex flex-col gap-6">
        {p.latest?.message && (
          <Callout tone={PROBE_TONE[status]} title="Latest result">
            {p.latest.message}
          </Callout>
        )}
        <Facts
          items={[
            ['Latest', formatMetric(p.latest?.metric, unit)],
            ['Checked', p.latest ? <time key="t" dateTime={p.latest.ts} title={formatTimestamp(p.latest.ts)}>{formatRelative(p.latest.ts, now)}</time> : null],
            ['Thresholds', thresholdText(p) ?? 'None — pass or fail only'],
            ['Probe', <code key="k" className="font-mono text-xs">{p.key}</code>],
          ]}
        />
        {q.isError ? (
          <QueryError compact title="Results didn’t load" error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isPending && !p.series.length ? (
          <Skeleton shape="block" className="h-56 w-full" />
        ) : points.some((x) => x.metric !== null) ? (
          <Chart
            title={`${p.title}, last 24 hours`}
            kind="line"
            height={220}
            categoryLabel="Time (UTC)"
            categories={points.map((x) => formatTimestamp(x.ts).slice(11, 16))}
            series={[{ name: unit ? `Result (${unit})` : 'Result', data: points.map((x) => x.metric) }]}
            valueFormat={(v) => formatMetric(v, unit)}
          />
        ) : (
          <EmptyState compact title="No results in the last 24 hours" />
        )}
        <section aria-label="Recent problems" className="flex flex-col gap-2">
          <h3 className="af-eyebrow">Recent problems</h3>
          {failures.length === 0 ? (
            <p className="text-sm text-fg-3">No degraded or failing results in this window.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {failures.map((f) => {
                const Glyph = STATUS_ICON[PROBE_TONE[f.status]];
                return (
                  <li key={f.ts} className="flex items-start gap-2">
                    <Glyph size={14} weight="fill" aria-hidden className={cn('mt-0.5 shrink-0', TONE_TEXT[PROBE_TONE[f.status]])} />
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                      <time dateTime={f.ts} className="font-mono text-xs text-fg-3">
                        {formatTimestamp(f.ts).slice(5, 16)}
                      </time>
                      <span className="sr-only">{PROBE_LABEL[f.status]}: </span>
                      <span className="text-fg-2">{f.message ?? formatMetric(f.metric, unit)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}

/** Synthetic monitoring (R6): probe tiles grouped by kind, worst first, with sparkline and thresholds; detail chart. */
export function MonitoringPage({ search }: { search: MonitoringSearch }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const q = useQuery(probesQuery);
  useDocumentTitle('Synthetic monitoring');
  const show = search.show ?? 'all';
  const probes = useMemo(() => q.data?.items ?? [], [q.data]);
  const counts = { ok: 0, warn: 0, crit: 0, unknown: 0 } as Record<ProbeStatus, number>;
  for (const p of probes) counts[statusOf(p)]++;
  const visible = show === 'problems' ? probes.filter((p) => statusOf(p) === 'warn' || statusOf(p) === 'crit') : probes;
  const groups = useMemo(() => {
    const by = new Map<string, ProbeItem[]>();
    for (const p of visible) by.set(p.kind, [...(by.get(p.kind) ?? []), p]);
    return [...by.entries()]
      .map(([kind, items]) => ({ kind, items: items.sort((a, b) => severity(b) - severity(a) || a.title.localeCompare(b.title)) }))
      .sort((a, b) => Math.max(...b.items.map(severity)) - Math.max(...a.items.map(severity)) || (PROBE_KIND_LABEL[a.kind] ?? a.kind).localeCompare(PROBE_KIND_LABEL[b.kind] ?? b.kind));
  }, [visible]);
  const selected = search.probe ? probes.find((p) => p.key === search.probe) : undefined;
  const setSearch = (patch: Partial<MonitoringSearch>) =>
    void navigate({ to: '/monitoring', search: (prev: MonitoringSearch) => ({ ...prev, ...patch }), replace: true });

  return (
    <>
      <PageHeader
        eyebrow="Automation"
        title="Synthetic monitoring"
        description="Probes that check Microsoft Graph and Azure reachability, token acquisition, sign-in health, certificates, DNS and licence seats — on a schedule, as the automation identity."
        actions={
          <>
            <SegmentedControl
              aria-label="Show probes"
              value={show}
              onValueChange={(v) => setSearch({ show: v === 'problems' ? 'problems' : undefined })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'problems', label: 'Problems' },
              ]}
            />
            <IconButton label="Refresh" icon={<ArrowClockwiseIcon size={16} />} onClick={() => void q.refetch()} />
          </>
        }
      />
      <div className="flex flex-col gap-8">
        <KpiStrip label="Probe health" className="xl:grid-cols-4">
          <Kpi variant="cell" label="Healthy" value={q.isPending ? null : counts.ok} status={{ tone: 'ok', label: `of ${probes.length} probes` }} loading={q.isPending} />
          <Kpi variant="cell" label="Degraded" value={q.isPending ? null : counts.warn} status={{ tone: counts.warn ? 'warn' : 'neutral', label: 'over the warning threshold' }} loading={q.isPending} />
          <Kpi variant="cell" label="Failing" value={q.isPending ? null : counts.crit} status={{ tone: counts.crit ? 'crit' : 'neutral', label: 'failed or over critical' }} loading={q.isPending} />
          <Kpi variant="cell" label="No data" value={q.isPending ? null : counts.unknown} hint="not run yet or not scheduled" loading={q.isPending} />
        </KpiStrip>
        {q.isError ? (
          <Panel>
            <QueryError title="Probes didn’t load" error={q.error} onRetry={() => void q.refetch()} />
          </Panel>
        ) : q.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} shape="block" className="h-36" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Panel>
            <EmptyState title={show === 'problems' ? 'Every probe is healthy' : 'No probes yet'}>
              {show === 'problems' ? 'Nothing is degraded or failing right now.' : 'Add one with pnpm adminforge new probe, then schedule it.'}
            </EmptyState>
          </Panel>
        ) : (
          // Groups flow into columns (worst group first), so one probe of a kind doesn't take a whole row.
          <div className="columns-1 gap-6 md:columns-2 xl:columns-3 2xl:columns-4">
            {groups.map((g) => {
              const worst = g.items[0] ? statusOf(g.items[0]) : 'unknown';
              const Glyph = STATUS_ICON[PROBE_TONE[worst]];
              return (
                <section key={g.kind} aria-labelledby={`probes-${g.kind}`} className="mb-6 flex break-inside-avoid flex-col gap-3">
                  <h2 id={`probes-${g.kind}`} className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Glyph size={15} weight="fill" aria-hidden className={TONE_TEXT[PROBE_TONE[worst]]} />
                    {PROBE_KIND_LABEL[g.kind] ?? g.kind}
                    <span className="font-normal text-fg-3">· {g.items.length}</span>
                  </h2>
                  {g.items.map((p) => (
                    <ProbeTile key={p.key} p={p} now={now} onOpen={() => setSearch({ probe: p.key })} />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </div>
      {selected && <ProbeDetail key={selected.key} p={selected} onClose={() => setSearch({ probe: undefined })} />}
    </>
  );
}
