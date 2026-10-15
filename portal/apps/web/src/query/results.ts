import type { ResultColumn } from './contracts';

/** How a KQL column type is shown, sorted, filtered and exported. */
export type ValueKind = 'number' | 'datetime' | 'bool' | 'guid' | 'dynamic' | 'timespan' | 'text';

const NUMERIC = new Set(['int', 'long', 'real', 'decimal', 'double', 'float', 'integer', 'number']);

export function valueKind(type: string): ValueKind {
  const t = type.toLowerCase();
  if (NUMERIC.has(t)) return 'number';
  if (t === 'datetime' || t === 'date') return 'datetime';
  if (t === 'bool' || t === 'boolean') return 'bool';
  if (t === 'guid' || t === 'uniqueidentifier') return 'guid';
  if (t === 'dynamic' || t === 'object' || t === 'array') return 'dynamic';
  if (t === 'timespan') return 'timespan';
  return 'text';
}

export const isNumericColumn = (c: ResultColumn) => valueKind(c.type) === 'number';

/** A number from a numeric cell (services send longs as strings sometimes), else null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Plain text of any cell: what search, copy and CSV use. Objects and arrays become compact JSON. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * CSV for spreadsheets (RFC 4180, CRLF). Cells that a spreadsheet would run as a formula (= + - @, tab, CR)
 * are prefixed with an apostrophe, because query results routinely carry attacker-controlled text
 * (sign-in user agents, email subjects, resource tags).
 */
export function toCsv(columns: ResultColumn[], rows: Array<Record<string, unknown>>): string {
  const esc = (raw: string) => {
    const s = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.name)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(cellText(r[c.name]))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Tab-separated text for pasting into a spreadsheet or a ticket. Tabs and newlines inside cells become spaces. */
export function toTsv(columns: ResultColumn[], rows: Array<Record<string, unknown>>): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  return [columns.map((c) => clean(c.name)).join('\t'), ...rows.map((r) => columns.map((c) => clean(cellText(r[c.name]))).join('\t'))].join('\n');
}

/** `query-resourcegraph-2026-10-15T14-03-22Z.csv` */
export function csvFileName(source: string, now: Date = new Date()): string {
  return `query-${source.toLowerCase()}-${now.toISOString().slice(0, 19).replace(/:/g, '-')}Z.csv`;
}

/** Starts a browser download of `text` (client-side; nothing goes back to the server). */
export function downloadText(text: string, fileName: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Chart data ────────────────────────────────────────────────────────────────

export interface ChartConfig {
  x: string;
  y: string;
  /** Optional column whose values become separate series. */
  split?: string;
  kind: 'bar' | 'line' | 'area';
}

export interface ChartData {
  categories: string[];
  series: Array<{ name: string; data: Array<number | null> }>;
  /** Categories dropped beyond the cap. */
  droppedCategories: number;
  /** Series folded into "Other" beyond the palette size. */
  foldedSeries: number;
}

export const MAX_CATEGORIES = 200;

/** Short, sortable label for a category value; datetimes become "2026-10-15 14:00" (UTC). */
export function categoryLabel(v: unknown, kind: ValueKind): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (kind === 'datetime') {
    const d = new Date(String(v));
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString();
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
    }
  }
  return cellText(v);
}

/**
 * Time labels without the parts every label shares: one day → "14:00"; one year → "10-15 14:00"; midnights only
 * stay dates. (Labels are already sorted "YYYY-MM-DD HH:MM" strings.)
 */
export function shortenTimes(labels: string[], kind: ValueKind): string[] {
  if (kind !== 'datetime' || labels.length < 2 || !labels.every((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(l))) return labels;
  const day = (l: string) => l.slice(0, 10);
  if (labels.every((l) => day(l) === day(labels[0]!))) return labels.map((l) => l.slice(11));
  if (labels.every((l) => l.slice(0, 4) === labels[0]!.slice(0, 4))) return labels.map((l) => l.slice(5));
  return labels;
}

/** A sensible first chart: x = first text/datetime column, y = first numeric column, split = a second text column. */
export function defaultChartConfig(columns: ResultColumn[]): ChartConfig | null {
  const y = columns.find(isNumericColumn);
  if (!y) return null;
  const x = columns.find((c) => valueKind(c.type) === 'datetime') ?? columns.find((c) => c !== y && !isNumericColumn(c)) ?? columns.find((c) => c !== y);
  if (!x) return null;
  const split = valueKind(x.type) === 'datetime' ? columns.find((c) => c !== x && valueKind(c.type) === 'text') : undefined;
  return { x: x.name, y: y.name, ...(split ? { split: split.name } : {}), kind: valueKind(x.type) === 'datetime' ? 'line' : 'bar' };
}

/**
 * Pivots result rows into chart categories and series. Values with the same category (and series) are summed.
 * Datetime categories are sorted; others keep the query's order. At most `maxSeries` series: the largest by total,
 * the rest folded into "Other" (never more hues than the validated palette).
 */
export function chartData(columns: ResultColumn[], rows: Array<Record<string, unknown>>, cfg: ChartConfig, maxSeries = 6): ChartData {
  const xCol = columns.find((c) => c.name === cfg.x);
  const xKind = xCol ? valueKind(xCol.type) : 'text';
  const order: string[] = [];
  const seen = new Set<string>();
  const cells = new Map<string, Map<string, number>>(); // series → category → sum
  const totals = new Map<string, number>();

  for (const r of rows) {
    const cat = categoryLabel(r[cfg.x], xKind);
    if (!seen.has(cat)) {
      seen.add(cat);
      order.push(cat);
    }
    const name = cfg.split ? categoryLabel(r[cfg.split], 'text') : cfg.y;
    const v = toNumber(r[cfg.y]);
    if (v === null) continue;
    const bucket = cells.get(name) ?? new Map<string, number>();
    bucket.set(cat, (bucket.get(cat) ?? 0) + v);
    cells.set(name, bucket);
    totals.set(name, (totals.get(name) ?? 0) + v);
  }

  if (xKind === 'datetime') order.sort();
  const categories = shortenTimes(order.slice(0, MAX_CATEGORIES), xKind);
  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const keep = ranked.length > maxSeries ? ranked.slice(0, maxSeries - 1) : ranked;
  const folded = ranked.slice(keep.length);

  const keys = order.slice(0, MAX_CATEGORIES);
  const series = keep.map((name) => ({ name, data: keys.map((c) => cells.get(name)?.get(c) ?? null) }));
  if (folded.length) {
    series.push({
      name: `Other (${folded.length})`,
      data: keys.map((c) => {
        let sum: number | null = null;
        for (const name of folded) {
          const v = cells.get(name)?.get(c);
          if (v !== undefined) sum = (sum ?? 0) + v;
        }
        return sum;
      }),
    });
  }
  return { categories, series, droppedCategories: order.length - categories.length, foldedSeries: folded.length };
}
