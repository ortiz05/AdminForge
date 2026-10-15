import { useMemo, useState } from 'react';
import {
  Chart,
  ChartLineIcon,
  SegmentedControl,
  Skeleton,
  TableIcon,
  chart as chartRecipe,
  cn,
  formatNumber,
} from '@adminforge/ui';
import { formatValue } from '../../lib/format';
import { asRows } from '../../lib/path';
import { WidgetPanel } from '../../lib/WidgetPanel';
import type { WidgetProps } from '../../types';
import { prepareHeatGrid, prepareSeries, prepareSlices, type HeatGridData, type Slice } from './prepare';
import type { ChartConfig } from './schema';

/** Categorical slots in fixed order (never generated hues). */
const SWATCH = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'] as const;
const STROKE = ['stroke-chart-1', 'stroke-chart-2', 'stroke-chart-3', 'stroke-chart-4', 'stroke-chart-5', 'stroke-chart-6'] as const;
/** Heat buckets: one hue (temper blue), five steps; empty cells sit on the sunken surface. */
const HEAT = ['bg-accent/10', 'bg-accent/25', 'bg-accent/45', 'bg-accent/65', 'bg-accent/90'] as const;

function ViewToggle({ title, view, onChange }: { title: string; view: string; onChange: (v: 'chart' | 'table') => void }) {
  return (
    <SegmentedControl
      size="sm"
      aria-label={`${title}: view as`}
      value={view}
      onValueChange={(v) => onChange(v as 'chart' | 'table')}
      options={[
        { value: 'chart', label: <ChartLineIcon size={14} aria-hidden />, 'aria-label': 'Chart' },
        { value: 'table', label: <TableIcon size={14} aria-hidden />, 'aria-label': 'Table' },
      ]}
    />
  );
}

function ValuesTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: Array<{ name: string; cells: string[] }>;
}) {
  const s = chartRecipe();
  return (
    <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label={`${title} data`}>
      <table className={s.table()}>
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h + i} scope="col" className={s.th({ className: i > 0 ? 'text-right' : undefined })}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row" className={s.td({ className: 'font-medium text-fg' })}>
                {r.name}
              </th>
              {r.cells.map((c, i) => (
                <td key={i} className={s.td({ className: s.num() })}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Donut (≤ 6 slices) with a legend that carries name, value and share — the colour is never the only cue. */
export function Donut({ title, slices, format }: { title: string; slices: Slice[]; format: (v: number) => string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  const gap = slices.length > 1 ? 2 : 0;
  const lengths = slices.map((sl) => (total ? (sl.value / total) * C : 0));
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  const pct = (v: number) => (total ? `${Math.round((v / total) * 100)}%` : '—');
  const s = chartRecipe();
  return (
    <figure className="m-0 flex flex-col gap-3" aria-label={title}>
      <div className="flex justify-end">
        <ViewToggle title={title} view={view} onChange={setView} />
      </div>
      {view === 'chart' ? (
        <div className="flex flex-wrap items-center gap-6">
          <svg
            viewBox="0 0 140 140"
            width={140}
            height={140}
            role="img"
            aria-label={`${title}: ${slices.map((sl) => `${sl.name} ${format(sl.value)} (${pct(sl.value)})`).join(', ')}`}
            className="shrink-0"
          >
            <circle cx={70} cy={70} r={R} fill="none" strokeWidth={16} className="stroke-sunken" />
            {slices.map((sl, i) => {
              const visible = Math.max(0, lengths[i]! - gap);
              return (
                <circle
                  key={sl.name}
                  cx={70}
                  cy={70}
                  r={R}
                  fill="none"
                  strokeWidth={16}
                  className={STROKE[i % STROKE.length]}
                  strokeDasharray={`${visible} ${C - visible}`}
                  strokeDashoffset={-offsets[i]!}
                  transform="rotate(-90 70 70)"
                />
              );
            })}
            <text x={70} y={68} textAnchor="middle" className="af-display fill-fg text-xl font-semibold">
              {format(total)}
            </text>
            <text x={70} y={86} textAnchor="middle" className="fill-fg-3 text-2xs">
              Total
            </text>
          </svg>
          <ul className="flex min-w-48 flex-1 flex-col gap-1.5" aria-label="Legend">
            {slices.map((sl, i) => (
              <li key={sl.name} className="flex items-center gap-2 text-sm">
                <span className={s.swatch({ className: SWATCH[i % SWATCH.length] })} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-fg-2">{sl.name}</span>
                <span className="font-mono text-xs tabular-nums text-fg">{format(sl.value)}</span>
                <span className="w-10 text-right font-mono text-xs tabular-nums text-fg-3">{pct(sl.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ValuesTable
          title={title}
          head={['Category', 'Value', 'Share']}
          rows={slices.map((sl) => ({ name: sl.name, cells: [format(sl.value), pct(sl.value)] }))}
        />
      )}
    </figure>
  );
}

const bucket = (v: number, max: number) => (max <= 0 ? 0 : Math.min(HEAT.length - 1, Math.floor((v / max) * HEAT.length)));

/** Heat grid as a real table (rows × columns), shaded in one hue; exact values in each cell and the table view. */
export function HeatGrid({ title, grid, format }: { title: string; grid: HeatGridData; format: (v: number) => string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure className="m-0 flex flex-col gap-3" aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-2xs text-fg-3" aria-hidden>
          <span>Fewer</span>
          {HEAT.map((h) => (
            <span key={h} className={cn('size-3 rounded-sm', h)} />
          ))}
          <span>More</span>
        </div>
        <ViewToggle title={title} view={view} onChange={setView} />
      </div>
      {view === 'chart' ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0.5 text-2xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <td />
                {grid.columns.map((c, i) => (
                  <th key={`${c}-${i}`} scope="col" className="px-1 pb-1 text-center font-medium whitespace-nowrap text-fg-3">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.name}>
                  <th scope="row" className="pr-2 text-left font-medium whitespace-nowrap text-fg-2">
                    {r.name}
                  </th>
                  {r.values.map((v, i) => {
                    const b = v == null ? -1 : bucket(v, grid.max);
                    return (
                      <td
                        key={i}
                        className={cn(
                          'h-7 min-w-8 rounded-sm text-center font-mono tabular-nums',
                          b < 0 ? 'bg-sunken text-fg-3' : HEAT[b],
                          b >= 3 ? 'font-semibold text-on-accent' : 'text-fg',
                        )}
                      >
                        {v == null ? '' : format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ValuesTable
          title={title}
          head={['', ...grid.columns]}
          rows={grid.rows.map((r) => ({ name: r.name, cells: r.values.map((v) => (v == null ? '—' : format(v))) }))}
        />
      )}
    </figure>
  );
}

/** line · area · bar · stackedBar (ECharts, themed) · donut · heatGrid — always with a Table toggle. */
export function ChartWidget({ config, data, runtime }: WidgetProps<ChartConfig>) {
  const rows = useMemo(() => asRows(data.value), [data.value]);
  const title = config.title ?? 'Chart';
  const format = useMemo(() => (v: number) => (config.format ? formatValue(v, config.format) : formatNumber(v)), [config.format]);
  const height = (config.rows ?? 2) * 120;

  let body;
  let empty = rows.length === 0;
  if (config.type === 'donut') {
    const slices = prepareSlices(rows, config);
    empty = slices.length === 0;
    body = <Donut title={title} slices={slices} format={format} />;
  } else if (config.type === 'heatGrid') {
    const grid = prepareHeatGrid(rows, config);
    empty = grid.rows.length === 0;
    body = <HeatGrid title={title} grid={grid} format={format} />;
  } else {
    const prepared = prepareSeries(rows, config);
    const kind = config.type === 'stackedBar' ? 'bar' : config.type;
    // Long category names (resource types, products) read better as horizontal bars.
    const horizontal = kind === 'bar' && prepared.categories.some((c) => c.length > 14);
    body = (
      <Chart
        title={title}
        kind={kind}
        categories={prepared.categories}
        series={prepared.series}
        stacked={config.type === 'stackedBar' || Boolean(config.stack)}
        height={horizontal ? Math.max(height, prepared.categories.length * 28 + 48) : height}
        horizontal={horizontal}
        valueFormat={format}
        axisFormat={config.format && config.format !== 'number' ? format : undefined}
        categoryLabel={config.xLabel ?? 'Category'}
      />
    );
  }

  return (
    <WidgetPanel
      config={config}
      data={data}
      runtime={runtime}
      name={title}
      isEmpty={empty}
      emptyDefault={{ title: 'Nothing to chart yet', body: 'No data matches the current filters.' }}
      skeleton={<Skeleton shape="block" className="w-full" style={{ height }} />}
    >
      {body}
    </WidgetPanel>
  );
}
