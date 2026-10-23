import { useMemo } from 'react';
import { Chart, cn, Panel, STATUS_ICON } from '@adminforge/ui';
import { hourlyBuckets, passRates, rowSummary, type HourBucket } from './monitoring-model';
import { PROBE_LABEL, PROBE_TONE, type ProbeItem, type ProbeStatus } from './schedules';
import { TONE_TEXT } from './probe-format';

/**
 * An hour's cell shows its worst result twice over — by colour and by height (failing full, degraded three quarters,
 * healthy half, no results a line) — so it reads in greyscale and without telling the colours apart.
 */
const CELL: Record<ProbeStatus, string> = {
  crit: 'h-4 bg-crit',
  warn: 'h-3 bg-warn',
  ok: 'h-2 bg-ok',
  unknown: 'h-1 bg-line',
};
const LEGEND: ProbeStatus[] = ['ok', 'warn', 'crit', 'unknown'];
const hourText = (t: number) => `${new Date(t).toISOString().slice(11, 13)}:00`;

function cellLabel(row: string, b: HourBucket): string {
  const from = `${row}, ${hourText(b.start)}–${hourText(b.start + 3_600_000)} UTC`;
  if (b.worst === 'unknown') return `${from}: no results`;
  const parts = [
    b.crit && `${b.crit} failing`,
    b.warn && `${b.warn} degraded`,
    b.ok && `${b.ok} healthy`,
  ].filter(Boolean);
  return `${from}: ${PROBE_LABEL[b.worst]} (${parts.join(', ')})`;
}

/**
 * The last 24 hours of the checks in scope: the share of results that passed, hour by hour (0–100 %), and one row per
 * service (or kind of check) with the worst result of each hour. Rows say in words what the cells show.
 */
export function HealthTimeline({
  rows,
  now,
}: {
  rows: Array<{ key: string; label: string; probes: ProbeItem[] }>;
  now: number;
}) {
  const all = useMemo(() => rows.flatMap((r) => r.probes), [rows]);
  const buckets = useMemo(() => hourlyBuckets(all, now), [all, now]);
  const lines = useMemo(
    () => rows.map((r) => ({ ...r, buckets: hourlyBuckets(r.probes, now) })),
    [rows, now],
  );
  const categories = buckets.map((b) => hourText(b.start));
  return (
    <Panel
      title="Health over the last 24 hours"
      description="Every result of the checks in scope, hour by hour (UTC)."
    >
      <div className="grid gap-6 xl:grid-cols-5">
        <figure className="flex min-w-0 flex-col gap-2 xl:col-span-2">
          <figcaption className="text-xs text-fg-2">Checks passing, per hour (%)</figcaption>
          <Chart
            title="Checks passing, per hour"
            kind="line"
            categories={categories}
            series={[{ name: 'Passing', data: passRates(buckets) }]}
            valueFormat={(v) => `${v}%`}
            axisFormat={(v) => `${v}%`}
            valueRange={{ min: 0, max: 100 }}
            categoryLabel="Hour (UTC)"
            height={200}
          />
        </figure>
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-3">
          <span className="text-xs text-fg-2">Worst result per hour</span>
          <ul className="flex flex-col gap-2" aria-label="Worst result per hour">
            {lines.map((r) => (
              <li key={r.key} className="flex flex-col gap-1 sm:flex-row sm:items-end sm:gap-3">
                <span className="truncate text-xs text-fg-2 sm:w-40 sm:shrink-0" title={r.label}>
                  {r.label}
                  <span className="sr-only">: {rowSummary(r.buckets)}</span>
                </span>
                <span className="grid h-4 min-w-0 flex-1 grid-cols-24 items-end gap-0.5" aria-hidden>
                  {r.buckets.map((b) => (
                    <span
                      key={b.start}
                      title={cellLabel(r.label, b)}
                      className={cn('rounded-sm', CELL[b.worst])}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex gap-3 text-2xs text-fg-3" aria-hidden>
            <span className="hidden sm:block sm:w-40 sm:shrink-0" />
            <span className="grid min-w-0 flex-1 grid-cols-24 gap-0.5">
              {[0, 6, 12, 18].map((i) => (
                <span key={i} className="col-span-6">
                  {categories[i]}
                </span>
              ))}
            </span>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-2" aria-label="Legend">
            {LEGEND.map((st) => {
              const Glyph = STATUS_ICON[PROBE_TONE[st]];
              return (
                <li key={st} className="flex items-center gap-1.5">
                  <span className="flex h-4 w-2 items-end" aria-hidden>
                    <span className={cn('w-2 rounded-sm', CELL[st])} />
                  </span>
                  <Glyph size={12} weight="fill" aria-hidden className={TONE_TEXT[PROBE_TONE[st]]} />
                  {st === 'unknown' ? 'No results' : PROBE_LABEL[st]}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
