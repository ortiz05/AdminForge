import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  CaretRightIcon,
  Chart,
  ChartLineIcon,
  CheckIcon,
  CopyIcon,
  DataTable,
  DownloadSimpleIcon,
  EmptyState,
  ErrorState,
  formatDuration,
  formatNumber,
  formatTimestamp,
  MAX_SERIES,
  Panel,
  ProvenanceFooter,
  SegmentedControl,
  Select,
  Skeleton,
  StatusPill,
  StopCircleIcon,
  TableIcon,
  useCopy,
  useNow,
  useToast,
  type DataColumn,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import type { QueryRequest, QueryResult, ResultColumn } from './contracts';
import type { ChartHint } from './gallery';
import {
  cellText,
  chartData,
  csvFileName,
  defaultChartConfig,
  downloadText,
  isNumericColumn,
  toCsv,
  toNumber,
  toTsv,
  valueKind,
  type ChartConfig,
} from './results';
import { SOURCE_META } from './sources';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number; request: QueryRequest }
  | { status: 'cancelled'; request: QueryRequest }
  | { status: 'error'; error: unknown; request: QueryRequest }
  | { status: 'done'; result: QueryResult; request: QueryRequest; finishedAt: string };

interface Row {
  i: number;
  r: Record<string, unknown>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string column whose sampled values are all GUIDs reads better as id chips (subscriptionId, tenantId…). */
function looksLikeGuids(rows: Array<Record<string, unknown>>, name: string): boolean {
  let seen = 0;
  for (const r of rows.slice(0, 50)) {
    const v = r[name];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'string' || !GUID.test(v)) return false;
    seen++;
  }
  return seen > 0;
}

function Mono({ text }: { text: string }) {
  return (
    <span className="truncate font-mono text-xs" title={text.length > 40 ? text : undefined}>
      {text}
    </span>
  );
}

export function resultColumns(columns: ResultColumn[], rows: Array<Record<string, unknown>>): DataColumn<Row>[] {
  return columns.map((c): DataColumn<Row> => {
    const kind = valueKind(c.type);
    const text = (row: Row) => cellText(row.r[c.name]);
    const base = { id: c.name, header: c.name, sortable: true };
    switch (kind) {
      case 'number':
        return { ...base, kind: 'number', value: (row) => toNumber(row.r[c.name]), align: 'end', filter: 'range' };
      case 'datetime':
        return {
          ...base,
          value: text,
          width: 'minmax(184px, 0.9fr)',
          cell: (row) => {
            const v = text(row);
            return v ? (
              <time dateTime={v} className="truncate font-mono text-xs tabular-nums">
                {formatTimestamp(v)}
              </time>
            ) : (
              <span className="text-fg-3">—</span>
            );
          },
        };
      case 'bool':
        return { ...base, value: (row) => (row.r[c.name] === null || row.r[c.name] === undefined ? null : text(row)), filter: 'facet' };
      case 'guid':
        return { ...base, kind: 'id', value: text };
      case 'dynamic':
      case 'timespan':
        return { ...base, value: text, width: 'minmax(180px, 1.2fr)', cell: (row) => (text(row) ? <Mono text={text(row)} /> : <span className="text-fg-3">—</span>) };
      default: {
        if (looksLikeGuids(rows, c.name)) return { ...base, kind: 'id', value: text };
        const armIds = rows.slice(0, 20).some((r) => typeof r[c.name] === 'string' && /^\/subscriptions\//i.test(r[c.name] as string));
        if (armIds) return { ...base, value: text, width: 'minmax(220px, 1.6fr)', cell: (row) => (text(row) ? <Mono text={text(row)} /> : <span className="text-fg-3">—</span>) };
        return { ...base, value: text };
      }
    }
  });
}

function Schema({ columns }: { columns: ResultColumn[] }) {
  return (
    <details className="group px-(--af-pad-panel) pb-3">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs text-fg-3 select-none hover:text-fg-2">
        <CaretRightIcon size={12} weight="bold" aria-hidden className="transition-transform duration-(--af-motion-fast) group-open:rotate-90 motion-reduce:transition-none" />
        Schema · {columns.length} column{columns.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Result columns and types">
        {columns.map((c) => (
          <li key={c.name}>
            <Badge mono tone="outline">
              {c.name}
              <span className="text-fg-3">{c.type}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ChartView({ result, hint }: { result: QueryResult; hint?: ChartHint }) {
  const names = new Set(result.columns.map((c) => c.name));
  const fromHint =
    hint && names.has(hint.x) && names.has(hint.y) ? { x: hint.x, y: hint.y, kind: hint.kind, ...(hint.split && names.has(hint.split) ? { split: hint.split } : {}) } : null;
  const [cfg, setCfg] = useState<ChartConfig | null>(fromHint ?? defaultChartConfig(result.columns));
  const numeric = result.columns.filter(isNumericColumn);
  const data = useMemo(() => (cfg ? chartData(result.columns, result.rows, cfg, MAX_SERIES) : null), [cfg, result]);

  if (!cfg || !numeric.length)
    return (
      <EmptyState compact title="Nothing to chart" className="py-10">
        The result has no numeric column. Aggregate first — for example <code className="font-mono text-xs">| summarize count() by type</code>.
      </EmptyState>
    );

  const set = (patch: Partial<ChartConfig>) => setCfg({ ...cfg, ...patch });
  const xIsTime = valueKind(result.columns.find((c) => c.name === cfg.x)?.type ?? '') === 'datetime';
  const NONE = '__none__';
  return (
    <div className="flex flex-col gap-4 px-(--af-pad-panel) pb-(--af-pad-panel)">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="X axis"
          className="w-52"
          value={cfg.x}
          onValueChange={(x) => set({ x, ...(cfg.split === x ? { split: undefined } : {}) })}
          options={result.columns.map((c) => ({ value: c.name, label: c.name, description: c.type }))}
        />
        <Select
          label="Y axis"
          className="w-52"
          value={cfg.y}
          onValueChange={(y) => set({ y })}
          options={numeric.map((c) => ({ value: c.name, label: c.name, description: c.type }))}
        />
        <Select
          label="Split by"
          className="w-52"
          value={cfg.split ?? NONE}
          onValueChange={(v) => set({ split: v === NONE ? undefined : v })}
          options={[
            { value: NONE, label: 'No split' },
            ...result.columns.filter((c) => c.name !== cfg.x && c.name !== cfg.y && !isNumericColumn(c)).map((c) => ({ value: c.name, label: c.name, description: c.type })),
          ]}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg" id="query-chart-kind">
            Chart
          </span>
          <SegmentedControl
            aria-label="Chart type"
            value={cfg.kind}
            onValueChange={(k) => set({ kind: k as ChartConfig['kind'] })}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'line', label: 'Line' },
              { value: 'area', label: 'Area' },
            ]}
          />
        </div>
      </div>
      {data && (
        <>
          <Chart
            title={`${cfg.y} by ${cfg.x}${cfg.split ? `, split by ${cfg.split}` : ''}`}
            kind={cfg.kind}
            categories={data.categories}
            series={data.series}
            categoryLabel={xIsTime ? `${cfg.x} (UTC)` : cfg.x}
            stacked={cfg.kind !== 'line' && Boolean(cfg.split)}
            height={320}
          />
          {(xIsTime || data.droppedCategories > 0 || data.foldedSeries > 0) && (
            <p className="text-xs text-fg-3">
              {xIsTime && 'Times are UTC. '}
              {data.droppedCategories > 0 && `Showing the first ${formatNumber(data.categories.length)} ${cfg.x} values; ${formatNumber(data.droppedCategories)} more are not drawn. `}
              {data.foldedSeries > 0 && `The smallest ${data.foldedSeries} series are combined as “Other”.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RunningState({ startedAt, onCancel }: { startedAt: number; onCancel: () => void }) {
  const now = useNow(1000);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="flex flex-col gap-3 px-(--af-pad-panel) pb-(--af-pad-panel)" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg-2">Running the query{secs >= 2 ? ` · ${secs} s` : '…'}</span>
        <Button size="sm" intent="ghost" onClick={onCancel}>
          <StopCircleIcon size={14} aria-hidden />
          Cancel
        </Button>
      </div>
      <Skeleton shape="block" className="h-8" />
      <Skeleton shape="block" className="h-40" />
    </div>
  );
}

export interface ResultsPanelProps {
  state: RunState;
  chartHint?: ChartHint;
  onRetry: () => void;
  onCancel: () => void;
}

export function ResultsPanel({ state, chartHint, onRetry, onCancel }: ResultsPanelProps) {
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [copied, copy] = useCopy();
  const { toast } = useToast();
  const done = state.status === 'done' ? state : null;
  const result = done?.result;

  const rows = useMemo<Row[]>(() => (result ? result.rows.map((r, i) => ({ i, r })) : []), [result]);
  const columns = useMemo(() => (result ? resultColumns(result.columns, result.rows) : []), [result]);

  const meta = done ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="tabular-nums">
        {done.result.truncated && done.result.rowCount > done.result.rows.length
          ? `${formatNumber(done.result.rows.length)} of ${formatNumber(done.result.rowCount)} rows`
          : `${formatNumber(done.result.rows.length)} row${done.result.rows.length === 1 ? '' : 's'}`}
      </span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{formatDuration(done.result.ms)}</span>
      <span aria-hidden>·</span>
      <span>{SOURCE_META[done.request.source].short}</span>
      {done.result.truncated && (
        <StatusPill status="warn" size="sm">
          Truncated
        </StatusPill>
      )}
    </span>
  ) : undefined;

  const actions = result && result.rows.length > 0 && (
    <>
      <SegmentedControl
        size="sm"
        aria-label="Show results as"
        value={view}
        onValueChange={(v) => setView(v as 'table' | 'chart')}
        options={[
          { value: 'table', label: <TableIcon size={14} aria-hidden />, 'aria-label': 'Table' },
          { value: 'chart', label: <ChartLineIcon size={14} aria-hidden />, 'aria-label': 'Chart' },
        ]}
      />
      <Button
        size="sm"
        intent="ghost"
        title="Copy every row as tab-separated text (pastes into a spreadsheet)"
        onClick={() =>
          void copy(toTsv(result.columns, result.rows)).then(() =>
            toast({ title: `Copied ${formatNumber(result.rows.length)} row${result.rows.length === 1 ? '' : 's'}`, tone: 'ok', duration: 2500 }),
          )
        }
      >
        {copied ? <CheckIcon size={14} aria-hidden className="text-ok" /> : <CopyIcon size={14} aria-hidden />}
        Copy
      </Button>
      <Button size="sm" intent="ghost" onClick={() => done && downloadText(toCsv(result.columns, result.rows), csvFileName(done.request.source))}>
        <DownloadSimpleIcon size={14} aria-hidden />
        Export CSV
      </Button>
    </>
  );

  return (
    <Panel
      title="Results"
      description={meta}
      actions={actions || undefined}
      flush
      footer={
        result?.provenance ? (
          <ProvenanceFooter
            service={result.provenance.service}
            path={result.provenance.path}
            ms={result.provenance.ms ?? result.ms}
            cachedAt={result.provenance.cachedAt}
            requestId={result.provenance.requestId}
          />
        ) : undefined
      }
    >
      {state.status === 'idle' && (
        <EmptyState compact title="Run a query to see results" className="py-10">
          Pick a starter query or write your own, then press Run.
        </EmptyState>
      )}
      {state.status === 'running' && <RunningState startedAt={state.startedAt} onCancel={onCancel} />}
      {state.status === 'cancelled' && (
        <EmptyState
          compact
          title="Query cancelled"
          className="py-10"
          action={
            <Button size="sm" onClick={onRetry}>
              Run again
            </Button>
          }
        >
          Nothing was returned. The service may still finish the work it started.
        </EmptyState>
      )}
      {state.status === 'error' && (
        <div className="px-(--af-pad-panel) pb-(--af-pad-panel)">
          <ErrorState
            title={state.error instanceof ApiRequestError && state.error.status === 400 ? 'The query didn’t run' : 'The query failed'}
            message={(state.error as Error)?.message}
            hint={state.error instanceof ApiRequestError ? state.error.hint : undefined}
            code={state.error instanceof ApiRequestError ? state.error.code : undefined}
            correlationId={state.error instanceof ApiRequestError ? state.error.correlationId : undefined}
            action={
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      )}
      {done && result && result.rows.length === 0 && (
        <EmptyState compact title="No rows" className="py-10">
          The query ran in {formatDuration(result.ms)} and returned nothing. Widen the time range or relax a filter.
        </EmptyState>
      )}
      {done && result && result.rows.length > 0 && (
        <>
          {result.truncated && (
            <p className="mx-(--af-pad-panel) mb-3 rounded-(--af-input-radius) border border-warn/40 bg-warn-subtle px-3 py-2 text-sm text-fg-2">
              Only the first {formatNumber(result.rows.length)}
              {result.rowCount > result.rows.length ? ` of ${formatNumber(result.rowCount)}` : ''} rows came back. Narrow the filters, or aggregate with{' '}
              <code className="rounded-sm bg-sunken px-1 font-mono text-xs text-fg">summarize</code>, to see the whole picture.
            </p>
          )}
          <Schema columns={result.columns} />
          {view === 'table' ? (
            <DataTable
              key={done.finishedAt}
              data={rows}
              columns={columns}
              getRowId={(row) => String(row.i)}
              label="Query results"
              searchPlaceholder="Search results…"
              maxHeight={560}
              className="rounded-none border-x-0 border-b-0"
            />
          ) : (
            <ChartView key={done.finishedAt} result={result} hint={chartHint} />
          )}
        </>
      )}
    </Panel>
  );
}
