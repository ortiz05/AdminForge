import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  button,
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
  type ProbePoint,
  type ProbeStatus,
} from './schedules';
import { splitHref } from '../lib/links';
import { useNav } from '../lib/session';
import { Callout, Facts, QueryError, useDocumentTitle } from './ui';

export interface MonitoringSearch {
  probe?: string;
  show?: 'all' | 'problems';
  /** Only the probes of one service (a probe `group`: `exchange`, `teams`, …). */
  group?: string;
  /** Group the tiles by check type instead of by service. */
  by?: 'check';
}

/** Probes without a `group`. */
const OTHER_GROUP = { key: 'other', label: 'Other checks', icon: 'pulse' };

const TONE_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-fg-3',
} as const;
const DAY_MS = 86_400_000;

/** KQL checks report a column name as their unit (`nonCompliantResources`); show it as words. */
export function humanUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  if (/^(%|ms|s|days|rows|failures|GB|MB)$/.test(unit)) return unit;
  return unit
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

export function formatMetric(value: number | null | undefined, rawUnit: string | null): string {
  if (value === null || value === undefined) return '—';
  const n =
    Math.abs(value) >= 100 ? formatNumber(Math.round(value)) : formatNumber(Math.round(value * 10) / 10);
  const unit = humanUnit(rawUnit);
  if (!unit) return n;
  if (unit === '%') return `${n}%`;
  // Counted units read in the singular for one: 1 day, 1 item, 1 row.
  if (value === 1 && /^(days|items|rows|events|failures)$/.test(unit)) return `${n} ${unit.slice(0, -1)}`;
  return `${n} ${unit}`;
}

export function thresholdText(p: ProbeItem): string | null {
  const { warn, crit, unit, worse } = p.thresholds;
  if (warn === null && crit === null) return null;
  const op = worse === 'higher' ? '≥' : '≤';
  return [
    warn !== null ? `warn ${op} ${formatMetric(warn, unit)}` : null,
    crit !== null ? `crit ${op} ${formatMetric(crit, unit)}` : null,
  ]
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
      {rest && value !== null && value !== undefined && (
        <span className="ml-1.5 text-sm font-medium text-fg-3">{rest}</span>
      )}
    </span>
  );
}

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
        <span className="truncate">
          {p.latest ? `checked ${formatRelative(p.latest.ts, now)}` : 'not checked yet'}
          {rate ? ` · ${rate}` : ''}
        </span>
        {p.latest?.message && status !== 'ok' && (
          <span className={cn('truncate', TONE_TEXT[tone])}>{p.latest.message}</span>
        )}
      </span>
    </button>
  );
}

/** `lastSignInDateTime` → "Last sign in date time", `OSVersion` → "OS version" (sentence case; acronyms stay). */
function columnLabel(name: string): string {
  const words = name.match(/[A-Z]{2,}(?=[A-Z][a-z]|\d|\b|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [name];
  const label = words.map((w) => (/^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? formatTimestamp(v) : v;
  return JSON.stringify(v);
}

const MAX_FOUND_ROWS = 25;
const MAX_FOUND_COLUMNS = 6;

/**
 * "What it found": the rows behind a result — the certificates about to expire, the resources that break a rule, the
 * failure reasons — so engineers don't go looking. Rows were read with application permissions: Operators see them,
 * others see why they don't.
 */
function FoundItems({ result }: { result: ProbePoint | undefined }) {
  if (!result) return null;
  if (result.detailsHidden)
    return (
      <section aria-labelledby="probe-found" className="flex flex-col gap-2">
        <h3 id="probe-found" className="af-eyebrow">
          What it found
        </h3>
        <p className="text-sm text-fg-3">
          The items behind this result are shown to Operators: the check read them with the automation
          identity’s application permissions.
        </p>
      </section>
    );
  const d = result.details;
  if (!d || !d.rows.length) return null;
  const columns = d.columns.slice(0, MAX_FOUND_COLUMNS);
  const rows = d.rows.slice(0, MAX_FOUND_ROWS);
  const more = Math.max(d.totalRows, d.rows.length) - rows.length;
  return (
    <section aria-labelledby="probe-found" className="flex flex-col gap-2">
      <h3 id="probe-found" className="af-eyebrow">
        What it found
      </h3>
      <div className="overflow-x-auto rounded-(--af-panel-radius) border border-line">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Items behind the latest result</caption>
          <thead className="bg-sunken text-fg-3">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {columns.map((c) => {
                  const text = cellText(r[c]);
                  return (
                    <td key={c} className="max-w-64 truncate px-3 py-1.5 text-fg-2" title={text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(more > 0 || d.truncated) && (
        <p className="text-xs text-fg-3">
          {more > 0 ? `${formatNumber(more)} more not shown here` : 'More not shown here'}
          {d.columns.length > columns.length ? `; ${d.columns.length - columns.length} more columns` : ''} —
          the linked page lists every one.
        </p>
      )}
    </section>
  );
}

/** "What to do" (the probe's remedy) and a way to act: an AdminForge page, or a Microsoft admin centre. */
function NextSteps({ p }: { p: ProbeItem }) {
  if (!p.remedy && !p.link) return null;
  const link = p.link;
  const external = link ? /^https:\/\//.test(link.href) : false;
  const target = link && !external ? splitHref(link.href) : null;
  return (
    <section aria-labelledby="probe-next" className="flex flex-col gap-2">
      <h3 id="probe-next" className="af-eyebrow">
        What to do
      </h3>
      {p.remedy && <p className="text-sm text-fg-2">{p.remedy}</p>}
      {link &&
        (external ? (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={cn(button({ intent: 'secondary', size: 'sm' }), 'self-start')}
          >
            {link.label}
          </a>
        ) : (
          <Link
            to={target!.pathname as never}
            search={target!.search as never}
            className={cn(button({ intent: 'secondary', size: 'sm' }), 'self-start')}
          >
            {link.label}
          </Link>
        ))}
    </section>
  );
}

function ProbeDetail({ p, service, onClose }: { p: ProbeItem; service?: string; onClose: () => void }) {
  const now = useNow(60_000);
  // Rounded to 5 minutes so the query key (and the fetch) only changes every few minutes.
  const since = new Date(Math.floor((now - DAY_MS) / 300_000) * 300_000).toISOString();
  const q = useQuery(probeResultsQuery(p.key, since));
  // Results come newest first; the chart and "Recent problems" read them oldest first.
  const points = [...(q.data?.items.length ? q.data.items : p.series)]
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .slice(-288);
  const newest = q.data?.items.length ? points[points.length - 1] : undefined;
  const unit = p.latest?.unit ?? p.thresholds.unit;
  const status = statusOf(p);
  const failures = points
    .filter((x) => x.status === 'crit' || x.status === 'warn')
    .slice(-8)
    .reverse();
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
        <FoundItems result={newest} />
        {status !== 'ok' && <NextSteps p={p} />}
        {p.summary && (
          <section aria-labelledby="probe-what" className="flex flex-col gap-2">
            <h3 id="probe-what" className="af-eyebrow">
              What this checks
            </h3>
            <p className="text-sm text-fg-2">{p.summary}</p>
          </section>
        )}
        {status === 'ok' && <NextSteps p={p} />}
        <Facts
          items={[
            ['Latest', formatMetric(p.latest?.metric, unit)],
            [
              'Checked',
              p.latest ? (
                <time key="t" dateTime={p.latest.ts} title={formatTimestamp(p.latest.ts)}>
                  {formatRelative(p.latest.ts, now)}
                </time>
              ) : null,
            ],
            ['Thresholds', thresholdText(p) ?? 'None — pass or fail only'],
            ['Service', service ?? null],
            [
              'Probe',
              <code key="k" className="font-mono text-xs">
                {p.key}
              </code>,
            ],
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
                    <Glyph
                      size={14}
                      weight="fill"
                      aria-hidden
                      className={cn('mt-0.5 shrink-0', TONE_TEXT[PROBE_TONE[f.status]])}
                    />
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

/**
 * Synthetic monitoring (R6): probe tiles grouped by the service they watch (Exchange Online, Teams, sign-in, …; or by
 * check type), worst group first, with sparkline and thresholds; detail chart. `?group=` narrows it to one service —
 * the check status at the end of each service's section row in the navigation links there.
 */
export function MonitoringPage({ search }: { search: MonitoringSearch }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const q = useQuery(probesQuery);
  const nav = useNav();
  const show = search.show ?? 'all';
  // One service on its own is grouped by check (its own section heading would only repeat the title).
  const byCheck = search.by === 'check' || !!search.group;
  const services = useMemo(() => {
    const m = new Map((q.data?.groups ?? []).map((g) => [g.key, g]));
    m.set(OTHER_GROUP.key, OTHER_GROUP);
    return m;
  }, [q.data]);
  /** The service a probe watches, or undefined when it names none ("Other checks" is a heading, not a service). */
  const serviceOf = (p: ProbeItem) => (p.group ? (services.get(p.group)?.label ?? p.group) : undefined);
  // The service's name comes from the probes, else from the navigation (a section without probes yet).
  const focus = search.group
    ? (services.get(search.group)?.label ??
      nav.data?.sections.find((sec) => sec.key === search.group)?.label ??
      search.group)
    : undefined;
  useDocumentTitle(focus ? `Service checks · ${focus}` : 'Synthetic monitoring');
  const probes = useMemo(
    () => (q.data?.items ?? []).filter((p) => !search.group || (p.group ?? OTHER_GROUP.key) === search.group),
    [q.data, search.group],
  );
  const counts = { ok: 0, warn: 0, crit: 0, unknown: 0 } as Record<ProbeStatus, number>;
  for (const p of probes) counts[statusOf(p)]++;
  const visible =
    show === 'problems' ? probes.filter((p) => statusOf(p) === 'warn' || statusOf(p) === 'crit') : probes;
  const order = useMemo(() => [...services.keys()], [services]);
  const groups = useMemo(() => {
    const by = new Map<string, ProbeItem[]>();
    const keyOf = (p: ProbeItem) => (byCheck ? p.kind : (p.group ?? OTHER_GROUP.key));
    for (const p of visible) by.set(keyOf(p), [...(by.get(keyOf(p)) ?? []), p]);
    const labelOf = (key: string) =>
      byCheck ? (PROBE_KIND_LABEL[key] ?? key) : (services.get(key) ?? OTHER_GROUP).label;
    const rank = (key: string) => (byCheck ? 0 : order.indexOf(key) < 0 ? order.length : order.indexOf(key));
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
  }, [visible, byCheck, services, order]);
  const selected = search.probe ? probes.find((p) => p.key === search.probe) : undefined;
  const setSearch = (patch: Partial<MonitoringSearch>) =>
    void navigate({
      to: '/monitoring',
      search: (prev: MonitoringSearch) => ({ ...prev, ...patch }),
      replace: true,
    });

  return (
    <>
      <PageHeader
        eyebrow={focus ?? 'Automation'}
        title={focus ? 'Service checks' : 'Synthetic monitoring'}
        description={
          focus
            ? `Synthetic tests and health checks of ${focus}, run on a schedule as the automation identity.`
            : 'Scheduled synthetic tests of Microsoft 365, Azure and AdminForge itself, run as the automation identity.'
        }
        actions={
          <>
            {search.group ? (
              <Link
                to="/monitoring"
                search={(prev: MonitoringSearch) => ({ ...prev, group: undefined, probe: undefined })}
                className={button({ intent: 'ghost' })}
              >
                All services
              </Link>
            ) : (
              <SegmentedControl
                aria-label="Group probes by"
                value={byCheck ? 'check' : 'service'}
                onValueChange={(v) => setSearch({ by: v === 'check' ? 'check' : undefined })}
                options={[
                  { value: 'service', label: 'By service' },
                  { value: 'check', label: 'By check' },
                ]}
              />
            )}
            <SegmentedControl
              aria-label="Show probes"
              value={show}
              onValueChange={(v) => setSearch({ show: v === 'problems' ? 'problems' : undefined })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'problems', label: 'Problems' },
              ]}
            />
            <IconButton
              label="Refresh"
              icon={<ArrowClockwiseIcon size={16} />}
              onClick={() => void q.refetch()}
            />
          </>
        }
      />
      <div className="flex flex-col gap-8">
        <KpiStrip label="Probe health" className="xl:grid-cols-4">
          <Kpi
            variant="cell"
            label="Healthy"
            value={q.isPending ? null : counts.ok}
            status={{ tone: 'ok', label: `of ${probes.length} probes` }}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Degraded"
            value={q.isPending ? null : counts.warn}
            status={{ tone: counts.warn ? 'warn' : 'neutral', label: 'over the warning threshold' }}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="Failing"
            value={q.isPending ? null : counts.crit}
            status={{ tone: counts.crit ? 'crit' : 'neutral', label: 'failed or over critical' }}
            loading={q.isPending}
          />
          <Kpi
            variant="cell"
            label="No data"
            value={q.isPending ? null : counts.unknown}
            hint="not run yet or not scheduled"
            loading={q.isPending}
          />
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
            {probes.length === 0 ? (
              <EmptyState title={focus ? `No checks for ${focus} yet` : 'No probes yet'}>
                Add one with{' '}
                <code className="font-mono text-xs">
                  pnpm adminforge new probe {search.group ?? '<section>'}/&lt;name&gt;
                </code>
                , then schedule it.
              </EmptyState>
            ) : (
              <EmptyState title="Every probe is healthy">
                Nothing is degraded or failing right now.
              </EmptyState>
            )}
          </Panel>
        ) : (
          // Groups flow into columns (worst group first), so one probe of a kind doesn't take a whole row.
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
                  <h2
                    id={`probes-${g.key}`}
                    className="flex items-center gap-2 text-sm font-semibold text-fg"
                  >
                    <Glyph size={15} weight="fill" aria-hidden className={TONE_TEXT[PROBE_TONE[worst]]} />
                    {g.label}{' '}
                    <span className="font-normal text-fg-3">
                      · {g.items.length}
                      <span className="sr-only"> {g.items.length === 1 ? 'probe' : 'probes'}</span>
                    </span>
                  </h2>
                  {g.items.map((p) => (
                    <ProbeTile
                      key={p.key}
                      p={p}
                      now={now}
                      context={byCheck && !search.group ? serviceOf(p) : undefined}
                      onOpen={() => setSearch({ probe: p.key })}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
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
