/** Display formatting shared by every primitive. Engineers read these values all day: be exact and short. */

const grouped = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 12408 → "12,408". */
export function formatNumber(value: number): string {
  return grouped.format(value);
}

/** 1284 → "1,284", 12900 → "12.9K", 4200000 → "4.2M" (grouped below 10,000 so small counts stay exact). */
export function formatCompact(value: number): string {
  return Math.abs(value) < 10_000 ? grouped.format(value) : compact.format(value);
}

/** 0.934 → "93%"; one decimal below 10 %. */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** 240 → "240 ms", 1234 → "1.2 s", 65000 → "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "30 s ago", "5 min ago", "3 h ago", "12 d ago", "in 4 min", "just now". */
export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const diff = now - toDate(value).getTime();
  if (Number.isNaN(diff)) return '—';
  const abs = Math.abs(diff);
  if (abs < 5_000) return 'just now';
  const [n, unit] =
    abs < 60_000
      ? [Math.round(abs / 1000), 's']
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), 'min']
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), 'h']
          : abs < 60 * 86_400_000
            ? [Math.round(abs / 86_400_000), 'd']
            : [Math.round(abs / (30 * 86_400_000)), 'mo'];
  return diff >= 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
}

/** Absolute timestamp for titles and tooltips: "2026-10-15 14:03:22 UTC". */
export function formatTimestamp(value: string | number | Date): string {
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** "3f2a…9c1d" — the head and tail of a GUID are what engineers compare. */
export function shorten(value: string, head = 4, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** "Mock Engineer" → "ME". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0], parts[0]?.[1]];
  return letters.filter(Boolean).join('').toUpperCase();
}
