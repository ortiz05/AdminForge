// Probe values for people: units, metrics, thresholds and pass rates (Monitoring's tiles and the probe drawer).
import { formatNumber, STATUS_SEVERITY } from '@adminforge/ui';
import { PROBE_TONE, type ProbeItem } from './schedules';
import { statusOf } from './monitoring-model';

export const TONE_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-fg-3',
} as const;
export const DAY_MS = 86_400_000;

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

export const severity = (p: ProbeItem) => STATUS_SEVERITY[PROBE_TONE[statusOf(p)]];

export function passRate(p: ProbeItem): string | null {
  const known = p.series.filter((x) => x.status !== 'unknown');
  if (known.length < 2) return null;
  const ok = known.filter((x) => x.status === 'ok').length;
  return `${ok} of ${known.length} checks healthy`;
}

/** Big number, small unit — long units (KQL column names) never dominate the tile. */
export function MetricValue({ value, unit }: { value: number | null | undefined; unit: string | null }) {
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
