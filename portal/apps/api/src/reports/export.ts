import { PassThrough, Readable } from 'node:stream';
import { renderString } from '@adminforge/expressions';
import {
  STATUS_TONE_LABEL,
  columnMapEntry,
  columnMapLabel,
  getPath,
  isStatusTone,
  splitDataRef,
  splitPath,
  tagList,
  type Datasource,
  type ExportSpec,
  type TableColumn,
  type TableWidgetConfig,
  type WidgetBlock,
} from '@adminforge/schemas';
import ExcelJS from 'exceljs';
import {
  dependencyErrors,
  type DatasourceRunner,
  type ErrorInfo,
  type LoadedPage,
  type RunInput,
} from '../datasources/executor';
import { AppError } from '../errors';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportPlan {
  spec: ExportSpec;
  datasource: string;
  /** Path inside the datasource result, e.g. ['value'], ['rows'] or ['value', 0, 'members']. */
  path: Array<string | number>;
  columns: TableColumn[];
  fileName: string;
  /** Rows come page by page (no transform, a collection result): streamed without holding everything in memory. */
  streamable: boolean;
  maxRows: number;
  /**
   * The datasource's own `maxItems` (a transformed datasource is sized for its transform budget): a non-streamed export
   * reads at most that many items, never more because the export allows more.
   */
  datasourceCap?: number;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const contentType = (f: ExportFormat) => CONTENT_TYPES[f];

const PAGEABLE = new Set<Datasource['source']>(['graph', 'arm', 'resourceGraph']);
const DATE_KINDS = new Set(['date', 'datetime', 'relativeTime']);

function tables(page: LoadedPage): TableWidgetConfig[] {
  const blocks: WidgetBlock[] = [
    ...(page.def.layout ?? []),
    ...(page.def.tabs ?? []).flatMap((t) => t.layout),
  ];
  return blocks.filter((b) => b.widget === 'table') as TableWidgetConfig[];
}

/** File name from the `fileName` template (rendered with params), reduced to safe characters. */
export async function exportFileName(
  spec: ExportSpec,
  page: LoadedPage,
  params: Record<string, unknown>,
  format: ExportFormat,
): Promise<string> {
  let base = page.key;
  if (spec.fileName) {
    try {
      base = String(await renderString(spec.fileName, { params }));
    } catch {
      base = page.key;
    }
  }
  base =
    base
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120) || 'export';
  return `${base}.${format}`;
}

/**
 * Which datasource and columns an export uses (§7.3): `export.data` (default: the first table's data), the columns of
 * the table bound to that data (`all` declared columns, or `visible` = not hidden / the user's chosen columns).
 */
export async function planExport(
  page: LoadedPage,
  params: Record<string, unknown>,
  format: ExportFormat,
  opts: { columns?: string[]; maxRows: number },
): Promise<ExportPlan> {
  const spec = page.def.export;
  if (!spec)
    throw new AppError(400, 'export_not_supported', `${page.kind} "${page.key}" does not declare an export.`);
  if (!spec.formats.includes(format))
    throw new AppError(
      400,
      'export_format',
      `${page.key} exports ${spec.formats.join(' or ')}, not ${format}.`,
    );
  const all = tables(page);
  const dataRef = spec.data ?? (all[0]?.data as string | undefined);
  if (!dataRef) throw new AppError(400, 'export_not_supported', `${page.key} has no table to export.`);
  // The table's own path reader (`value[0].items` included), so the file holds what the table shows.
  const { root: datasource, rest } = splitDataRef(dataRef);
  const path = [...splitPath(rest)];
  const ds = page.def.datasources?.[datasource];
  if (!ds)
    throw new AppError(
      400,
      'export_not_supported',
      `${page.key} exports unknown datasource "${datasource}".`,
    );
  const table = all.find((t) => (t.data as string | undefined) === dataRef) ?? all[0];
  if (!table)
    throw new AppError(400, 'export_not_supported', `${page.key} has no table columns for ${dataRef}.`);
  let columns = table.columns;
  if ((spec.columns ?? 'visible') === 'visible') {
    if (opts.columns?.length) {
      const byField = new Map(table.columns.map((c) => [c.field, c]));
      columns = opts.columns.map((f) => byField.get(f)).filter((c): c is TableColumn => !!c);
    } else columns = table.columns.filter((c) => !c.hidden);
  }
  if (!columns.length)
    throw new AppError(400, 'invalid_request', 'Choose at least one declared column to export.');
  const streamable =
    !ds.transform &&
    PAGEABLE.has(ds.source) &&
    path.length === 1 &&
    path[0] === 'value' &&
    (ds as { paging?: string }).paging !== 'none';
  return {
    spec,
    datasource,
    path,
    columns,
    fileName: await exportFileName(spec, page, params, format),
    streamable,
    maxRows: Math.min(spec.maxRows ?? opts.maxRows, opts.maxRows),
    ...(typeof (ds as { maxItems?: unknown }).maxItems === 'number'
      ? { datasourceCap: (ds as { maxItems: number }).maxItems }
      : {}),
  };
}

const asRows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];

/** One page of an export. */
export interface ExportPage {
  rows: Record<string, unknown>[];
  truncated: boolean;
  /**
   * `optional` datasources the exported one depends on that failed (`ds.<name>` → error): the rows were built without
   * them, so the file is incomplete. Callers record it (audit, schedule run) — it is never silently dropped.
   */
  incomplete?: Record<string, ErrorInfo>;
}

const withIncomplete = (
  page: Omit<ExportPage, 'incomplete'>,
  out: { errors?: Record<string, ErrorInfo> },
) => {
  const incomplete = dependencyErrors(out);
  return Object.keys(incomplete).length ? { ...page, incomplete } : page;
};

/** Pages of rows: cursor paging for streamable datasources, otherwise one collected (and transformed) result. */
export async function* exportPages(
  runner: DatasourceRunner,
  base: Omit<RunInput, 'datasource' | 'paging' | 'maxItems' | 'noCache'>,
  plan: ExportPlan,
): AsyncGenerator<ExportPage> {
  if (plan.streamable) {
    let cursor: string | undefined;
    let total = 0;
    do {
      const out = await runner.run({
        ...base,
        datasource: plan.datasource,
        paging: { cursor, pageSize: 999 },
        noCache: true,
      });
      const rows = asRows(getPath(out.data, plan.path));
      const take = rows.slice(0, plan.maxRows - total);
      total += take.length;
      cursor = out.cursor;
      yield withIncomplete(
        { rows: take, truncated: total >= plan.maxRows && (!!cursor || rows.length > take.length) },
        out,
      );
    } while (cursor && total < plan.maxRows);
    return;
  }
  const out = await runner.run({
    ...base,
    datasource: plan.datasource,
    paging: 'all',
    maxItems: Math.min(plan.maxRows, plan.datasourceCap ?? plan.maxRows),
    noCache: true,
  });
  const rows = asRows(getPath(out.data, plan.path));
  // Cut by the export's own limit, or the read stopped at the datasource's cap: either way the file says so.
  yield withIncomplete(
    { rows: rows.slice(0, plan.maxRows), truncated: rows.length > plan.maxRows || out.truncated === true },
    out,
  );
}

/** Collects the `incomplete` entries of export pages as they stream past (first failure per datasource kept). */
export function trackIncomplete(pages: AsyncIterable<ExportPage>): {
  pages: AsyncGenerator<ExportPage>;
  incomplete: Record<string, ErrorInfo>;
} {
  const incomplete: Record<string, ErrorInfo> = {};
  return {
    incomplete,
    pages: (async function* () {
      for await (const page of pages) {
        for (const [k, v] of Object.entries(page.incomplete ?? {})) incomplete[k] ??= v;
        yield page;
      }
    })(),
  };
}

/**
 * A cell's export value: the words a `status` column shows (the table's own lookup), the table's tag list, JSON for
 * objects, Date for date columns (xlsx).
 */
export function cellValue(
  row: Record<string, unknown>,
  col: TableColumn,
  format: ExportFormat,
): string | number | boolean | Date | null {
  const v = getPath(row, col.field);
  if (col.kind === 'status') {
    const hit = col.map ? columnMapEntry(col.map, v) : undefined;
    if (hit !== undefined) return columnMapLabel(hit);
    if (isStatusTone(v)) return STATUS_TONE_LABEL[v];
  }
  if (v === undefined || v === null) return null;
  if (col.kind === 'tags') return tagList(v).join('; ') || null;
  if (DATE_KINDS.has(col.kind ?? '') && typeof v === 'string' && format === 'xlsx') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (Array.isArray(v))
    return v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ');
  return JSON.stringify(v);
}

/** CSV field (RFC 4180) with spreadsheet formula injection neutralised (= + - @ tab CR at the start). */
export function csvField(v: string | number | boolean | Date | null): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v instanceof Date ? v.toISOString() : v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportStats {
  rows: number;
  truncated: boolean;
}

/**
 * The file as a stream. `first` is the already fetched first page (fetched before the response starts, so auth and
 * policy errors still return JSON); `rest` yields the remaining pages. `done` settles when the file is complete.
 */
export function exportStream(
  format: ExportFormat,
  columns: TableColumn[],
  pages: AsyncIterable<ExportPage>,
  done: (err: unknown, stats: ExportStats) => void,
): Readable {
  const stats: ExportStats = { rows: 0, truncated: false };
  if (format === 'csv') {
    async function* chunks(): AsyncGenerator<string> {
      try {
        yield `\uFEFF${columns.map((c) => csvField(c.label)).join(',')}\r\n`;
        for await (const page of pages) {
          stats.rows += page.rows.length;
          stats.truncated ||= page.truncated;
          if (page.rows.length)
            yield page.rows
              .map((r) => `${columns.map((c) => csvField(cellValue(r, c, 'csv'))).join(',')}\r\n`)
              .join('');
        }
        done(null, stats);
      } catch (err) {
        done(err, stats);
        throw err;
      }
    }
    return Readable.from(chunks(), { objectMode: false });
  }
  const out = new PassThrough();
  void (async () => {
    try {
      const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: out,
        useStyles: true,
        useSharedStrings: false,
      });
      const ws = wb.addWorksheet('Export');
      ws.columns = columns.map((c, i) => ({
        header: c.label,
        key: `c${i}`,
        width: Math.min(Math.max(c.label.length + 4, c.kind === 'identity' ? 28 : 14), 60),
      }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).commit();
      for await (const page of pages) {
        stats.rows += page.rows.length;
        stats.truncated ||= page.truncated;
        for (const r of page.rows) ws.addRow(columns.map((c) => cellValue(r, c, 'xlsx'))).commit();
      }
      ws.commit();
      await wb.commit();
      done(null, stats);
    } catch (err) {
      done(err, stats);
      out.destroy(err as Error);
    }
  })();
  return out;
}
