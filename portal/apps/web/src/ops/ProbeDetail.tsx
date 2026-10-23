import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  button,
  Chart,
  cn,
  Drawer,
  EmptyState,
  formatNumber,
  formatRelative,
  formatTimestamp,
  Skeleton,
  STATUS_ICON,
  StatusPill,
  useNow,
} from '@adminforge/ui';
import {
  PROBE_KIND_LABEL,
  PROBE_LABEL,
  PROBE_TONE,
  probeResultsQuery,
  type ProbeItem,
  type ProbePoint,
} from './schedules';
import { splitHref } from '../lib/links';
import { Callout, Facts, QueryError } from './ui';
import { DAY_MS, formatMetric, thresholdText, TONE_TEXT } from './probe-format';
import { statusOf } from './monitoring-model';

/** `lastSignInDateTime` → "Last sign in date time", `OSVersion` → "OS version" (sentence case; acronyms stay). */
function columnLabel(name: string): string {
  const words = name.match(/[A-Z]{2,}(?=[A-Z][a-z]|\d|\b|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [name];
  const label = words.map((w) => (/^[A-Z][a-z]/.test(w) ? w.toLowerCase() : w)).join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return ISO_TIME.test(v) ? formatTimestamp(v) : v;
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
                  // Times are short and carry the meaning: never cut them.
                  const time = typeof r[c] === 'string' && ISO_TIME.test(r[c]);
                  return (
                    <td
                      key={c}
                      className={cn(
                        'px-3 py-1.5 text-fg-2',
                        time ? 'whitespace-nowrap tabular-nums' : 'max-w-64 truncate',
                      )}
                      title={time ? undefined : text}
                    >
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

/** The probe's link: an AdminForge page that lists its items, or a Microsoft admin centre. */
function ProbeLink({ link }: { link: NonNullable<ProbeItem['link']> }) {
  const className = cn(button({ intent: 'secondary', size: 'sm' }), 'self-start');
  if (/^https:\/\//.test(link.href))
    return (
      <a href={link.href} target="_blank" rel="noreferrer" className={className}>
        {link.label}
      </a>
    );
  const target = splitHref(link.href);
  return (
    <Link to={target.pathname as never} search={target.search as never} className={className}>
      {link.label}
    </Link>
  );
}

/** "What to do" (the probe's remedy) and where to act — for a degraded or failing result only. */
function NextSteps({ p }: { p: ProbeItem }) {
  if (!p.remedy && !p.link) return null;
  return (
    <section aria-labelledby="probe-next" className="flex flex-col gap-2">
      <h3 id="probe-next" className="af-eyebrow">
        What to do
      </h3>
      {p.remedy && <p className="text-sm text-fg-2">{p.remedy}</p>}
      {p.link && <ProbeLink link={p.link} />}
    </section>
  );
}

/** "What this checks", and — while nothing is wrong — the link to where its items are (no remedy to follow). */
function WhatItChecks({ p, withLink }: { p: ProbeItem; withLink: boolean }) {
  const link = withLink ? p.link : null;
  if (!p.summary && !link) return null;
  return (
    <section aria-labelledby="probe-what" className="flex flex-col gap-2">
      <h3 id="probe-what" className="af-eyebrow">
        What this checks
      </h3>
      {p.summary && <p className="text-sm text-fg-2">{p.summary}</p>}
      {link && <ProbeLink link={link} />}
    </section>
  );
}

/** Fewer results than this in the window: an empty state says so instead of a one-point chart. */
const MIN_CHART_POINTS = 2;

/**
 * Why there's no history chart: no results in the window; a pass-or-fail check (no thresholds); results without a
 * measurement (a failed run records none); or a single measured result so far.
 */
function HistoryEmpty({
  points,
  measured,
  ran,
  passFail,
}: {
  points: number;
  measured: number;
  ran: boolean;
  passFail: boolean;
}) {
  const [title, body] =
    points === 0
      ? [
          'No results in the last 24 hours',
          ran
            ? 'The latest result is older than that. Check its schedule under Schedules: it may be switched off.'
            : 'It runs on its schedule; results appear here after the first run.',
        ]
      : measured === 0 && passFail
        ? ['Nothing to chart', 'This check passes or fails; it has no measurement to draw.']
        : measured === 0
          ? [
              'No measurements in the last 24 hours',
              'Every result failed before it could measure; Recent problems lists them.',
            ]
          : [
              'Not enough results to chart yet',
              'The chart starts once there are two measured results in the last 24 hours.',
            ];
  return (
    <EmptyState compact title={title}>
      {body}
    </EmptyState>
  );
}

export function ProbeDetail({
  p,
  service,
  onClose,
}: {
  p: ProbeItem;
  service?: string;
  onClose: () => void;
}) {
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
  // The remedy is for a degraded or failing result; healthy and not-yet-run probes only keep their link.
  const failing = status === 'warn' || status === 'crit';
  const measured = points.filter((x) => x.metric !== null).length;
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
        {failing && <NextSteps p={p} />}
        <WhatItChecks p={p} withLink={!failing} />
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
        <section aria-labelledby="probe-history" className="flex flex-col gap-2">
          <h3 id="probe-history" className="af-eyebrow">
            Last 24 hours
          </h3>
          {q.isError ? (
            <QueryError
              compact
              title="Results didn’t load"
              error={q.error}
              onRetry={() => void q.refetch()}
            />
          ) : q.isPending && !p.series.length ? (
            <Skeleton shape="block" className="h-56 w-full" />
          ) : measured >= MIN_CHART_POINTS ? (
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
            <HistoryEmpty
              points={points.length}
              measured={measured}
              ran={!!p.latest}
              passFail={thresholdText(p) === null}
            />
          )}
        </section>
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
