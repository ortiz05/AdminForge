import { MAX_SERIES } from '@adminforge/ui';
import { formatCategory, looksLikeDate } from '../../lib/format';
import { getPath, humanize } from '../../lib/path';
import type { ChartConfig } from './schema';

export interface PreparedSeries {
  name: string;
  data: Array<number | null>;
}

export interface PreparedChart {
  categories: string[];
  series: PreparedSeries[];
}

export interface Slice {
  name: string;
  value: number;
}

export const OTHER = 'Other';

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const key = (v: unknown) => (v == null || v === '' ? '—' : String(v));

/** Category labels: dates as "15 Oct" (with the hour when several fall on one day). */
function categoryLabels(raw: unknown[]): string[] {
  const dates = raw.filter(looksLikeDate);
  const days = new Set(dates.map((d) => d.slice(0, 10)));
  const intraDay = dates.length > 1 && days.size < dates.length;
  return raw.map((v) => formatCategory(v, intraDay));
}

const total = (s: PreparedSeries) => s.data.reduce<number>((a, b) => a + (b ?? 0), 0);

/** More than six series fold into "Other" (§7.4 chart rules); the six that remain keep their order. */
export function foldSeries(series: PreparedSeries[], max = MAX_SERIES): PreparedSeries[] {
  if (series.length <= max) return series;
  const keep = new Set(
    [...series]
      .sort((a, b) => total(b) - total(a))
      .slice(0, max - 1)
      .map((s) => s.name),
  );
  const kept = series.filter((s) => keep.has(s.name));
  const rest = series.filter((s) => !keep.has(s.name));
  const length = Math.max(...series.map((s) => s.data.length));
  const other: PreparedSeries = {
    name: OTHER,
    data: Array.from({ length }, (_, i) => {
      const vals = rest.map((s) => s.data[i]).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    }),
  };
  return [...kept, other];
}

/** Rows → categories + series for line/area/bar charts (one series per y field, or rows split by `series`). */
export function prepareSeries(rows: Record<string, unknown>[], config: ChartConfig): PreparedChart {
  const ys = Array.isArray(config.y) ? config.y : [config.y];
  const label = (k: string) => config.labels?.[k] ?? humanize(k);
  if (config.series) {
    const y = ys[0]!;
    const xs: unknown[] = [];
    const seenX = new Set<string>();
    const groups = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const x = getPath(row, config.x);
      const xk = key(x);
      if (!seenX.has(xk)) {
        seenX.add(xk);
        xs.push(x);
      }
      const sk = key(getPath(row, config.series));
      const g = groups.get(sk) ?? new Map<string, number>();
      groups.set(sk, g);
      const v = num(getPath(row, y));
      if (v != null) g.set(xk, (g.get(xk) ?? 0) + v);
    }
    const series = [...groups.entries()].map(([name, g]) => ({
      name: config.labels?.[name] ?? name,
      data: xs.map((x) => g.get(key(x)) ?? null),
    }));
    return { categories: categoryLabels(xs), series: foldSeries(series) };
  }
  const xs = rows.map((r) => getPath(r, config.x));
  return {
    categories: categoryLabels(xs),
    series: foldSeries(ys.map((y) => ({ name: label(y), data: rows.map((r) => num(getPath(r, y))) }))),
  };
}

/** Rows → donut slices (duplicates summed; more than six fold into "Other"; zero/negative values dropped). */
export function prepareSlices(rows: Record<string, unknown>[], config: ChartConfig): Slice[] {
  const y = Array.isArray(config.y) ? config.y[0]! : config.y;
  const sums = new Map<string, number>();
  for (const row of rows) {
    const v = num(getPath(row, y));
    if (v == null || v <= 0) continue;
    const k = key(getPath(row, config.x));
    sums.set(k, (sums.get(k) ?? 0) + v);
  }
  const slices = [...sums.entries()].map(([name, value]) => ({ name: config.labels?.[name] ?? name, value }));
  if (slices.length <= MAX_SERIES) return slices;
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, MAX_SERIES - 1);
  const rest = sorted.slice(MAX_SERIES - 1).reduce((a, s) => a + s.value, 0);
  return [...kept, { name: OTHER, value: rest }];
}

export interface HeatGridData {
  columns: string[];
  rows: Array<{ name: string; values: Array<number | null> }>;
  max: number;
}

/** Rows → a grid: `x` = column, `series` = row, `y` = value (duplicates summed). */
export function prepareHeatGrid(rows: Record<string, unknown>[], config: ChartConfig): HeatGridData {
  const y = Array.isArray(config.y) ? config.y[0]! : config.y;
  const xs: unknown[] = [];
  const seenX = new Set<string>();
  const byRow = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const x = getPath(row, config.x);
    const xk = key(x);
    if (!seenX.has(xk)) {
      seenX.add(xk);
      xs.push(x);
    }
    const rk = key(getPath(row, config.series ?? ''));
    const m = byRow.get(rk) ?? new Map<string, number>();
    byRow.set(rk, m);
    const v = num(getPath(row, y));
    if (v != null) m.set(xk, (m.get(xk) ?? 0) + v);
  }
  let max = 0;
  const out = [...byRow.entries()].map(([name, m]) => ({
    name: config.labels?.[name] ?? name,
    values: xs.map((x) => {
      const v = m.get(key(x));
      if (v != null && v > max) max = v;
      return v ?? null;
    }),
  }));
  return { columns: categoryLabels(xs), rows: out, max };
}
