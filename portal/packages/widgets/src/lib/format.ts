import { formatDuration, formatNumber, formatPercent, formatRelative, formatTimestamp, toDate } from '@adminforge/ui';

/** Formats shared by kpi, list, keyValue, chart and table (docs/widgets.md). */
export const VALUE_FORMATS = ['number', 'percent', 'bytes', 'duration', 'date', 'datetime', 'relativeTime', 'text'] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1.5 KB" (1024-based, one decimal from KB up). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  let v = Math.abs(bytes);
  let u = 0;
  while (v >= 1024 && u < BYTE_UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const n = u === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
  return `${bytes < 0 ? '−' : ''}${n} ${BYTE_UNITS[u]}`;
}

/** ISO 8601 duration (`PT5M30S`, `P2D`) or milliseconds → ms. */
export function toMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return Number.isFinite(Number(value)) ? Number(value) : undefined;
  const [, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return (((d! * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

/** "2026-10-15" (UTC, unambiguous for engineers in any locale). */
export function formatDate(value: unknown): string {
  const d = toDate(value as string);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

/** Percent values are fractions 0–1 (0.042 → "4.2%", 1.25 → "125%"). */
export function formatPercentValue(v: number): string {
  return formatPercent(v);
}

/** One display string for a value. Blank values render as an em dash. */
export function formatValue(value: unknown, format: ValueFormat | undefined, now: number = Date.now()): string {
  if (value === undefined || value === null || value === '') return '—';
  switch (format) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'percent':
      return typeof value === 'number' ? formatPercentValue(value) : String(value);
    case 'bytes':
      return typeof value === 'number' ? formatBytes(value) : String(value);
    case 'duration': {
      const ms = toMilliseconds(value);
      return ms === undefined ? String(value) : formatDuration(ms);
    }
    case 'date':
      return formatDate(value);
    case 'datetime':
      return formatTimestamp(value as string);
    case 'relativeTime':
      return formatRelative(value as string, now);
    case 'text':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    default:
      if (typeof value === 'number') return formatNumber(value);
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      if (Array.isArray(value)) return value.map((v) => formatValue(v, undefined, now)).join(', ');
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
export const looksLikeDate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v);

/** Axis/category label: dates become "15 Oct" (or "15 Oct 14:00" for intra-day buckets), others as text. */
export function formatCategory(value: unknown, withTime = false): string {
  if (looksLikeDate(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      return withTime
        ? `${day} ${d.toISOString().slice(11, 16)}`
        : day;
    }
  }
  return value == null || value === '' ? '—' : String(value);
}
