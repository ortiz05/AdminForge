import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartLineIcon, TableIcon } from '@phosphor-icons/react';
import { DEFAULT_THEME, THEME_NAMES, type ThemeName } from '@adminforge/design-tokens';
import { formatCompact, formatNumber } from '../lib/format';
import { useHtmlAttribute, useMediaQuery } from '../lib/hooks';
import type { ECharts } from '../lib/chart-runtime';

import { Skeleton } from './Skeleton';
import { SegmentedControl } from './Toggles';
import { chart } from '../recipes/chart';

/** Categorical slots in fixed order; a series keeps its colour when others are filtered out. */
const SWATCH = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'] as const;
export const MAX_SERIES = SWATCH.length;

export interface ChartSeries {
  name: string;
  data: Array<number | null>;
}

export interface ChartProps {
  /** Accessible name of the figure (the Panel title usually shows it visibly). */
  title: string;
  kind: 'line' | 'area' | 'bar';
  categories: string[];
  series: ChartSeries[];
  stacked?: boolean;
  height?: number;
  /** Formats values in tooltips and the table view. */
  valueFormat?: (value: number) => string;
  /** Formats value-axis labels (default: compact numbers). */
  axisFormat?: (value: number) => string;
  /** Bars along the y-axis — for long category names (bar charts only). */
  horizontal?: boolean;
  /** Header of the first column in the table view ("Day", "Service"). */
  categoryLabel?: string;
  defaultView?: 'chart' | 'table';
  className?: string;
}

const isTheme = (v: string | null): v is ThemeName => (THEME_NAMES as readonly string[]).includes(v ?? '');

/** ECharts bound to the token themes. Lazy-loads the runtime, follows `<html data-theme>`, and always offers a table view. */
export function Chart({
  title,
  kind,
  categories,
  series: allSeries,
  stacked,
  height = 240,
  valueFormat = formatNumber,
  axisFormat = formatCompact,
  horizontal = false,
  categoryLabel = 'Category',
  defaultView = 'chart',
  className,
}: ChartProps) {
  const [view, setView] = useState(defaultView);
  const [ready, setReady] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const instance = useRef<ECharts | null>(null);
  const themeAttr = useHtmlAttribute('data-theme');
  const theme = isTheme(themeAttr) ? themeAttr : DEFAULT_THEME;
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const series = useMemo(() => allSeries.slice(0, MAX_SERIES), [allSeries]);
  const s = chart();

  const option = useMemo(
    () => ({
      animation: !reducedMotion,
      animationDuration: 300,
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: kind === 'bar' ? ('shadow' as const) : ('line' as const) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? valueFormat(v) : '—'),
      },
      aria: { enabled: true, label: { description: title } },
      ...(horizontal && kind === 'bar'
        ? {
            yAxis: {
              type: 'category' as const,
              data: categories,
              inverse: true,
              axisLabel: { width: 180, overflow: 'truncate' as const },
            },
            xAxis: { type: 'value' as const, axisLabel: { formatter: (v: number) => axisFormat(v) } },
          }
        : {
            xAxis: { type: 'category' as const, data: categories, boundaryGap: kind === 'bar' },
            yAxis: { type: 'value' as const, axisLabel: { formatter: (v: number) => axisFormat(v) } },
          }),
      series: series.map((sr) =>
        kind === 'bar'
          ? {
              type: 'bar' as const,
              name: sr.name,
              data: sr.data,
              barMaxWidth: 24,
              stack: stacked ? 'total' : undefined,
            }
          : {
              type: 'line' as const,
              name: sr.name,
              data: sr.data,
              showSymbol: false,
              symbolSize: 8,
              lineStyle: { width: 2 },
              areaStyle: kind === 'area' ? { opacity: 0.1 } : undefined,
              stack: stacked ? 'total' : undefined,
              emphasis: { focus: 'series' as const },
            },
      ),
    }),
    [kind, categories, series, stacked, title, valueFormat, axisFormat, horizontal, reducedMotion],
  );

  // Mount the chart once the plot is visible; load the runtime on first use.
  useEffect(() => {
    if (view !== 'chart' || !plotRef.current) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import('../lib/chart-runtime').then(({ loadEcharts }) => {
      if (disposed || !plotRef.current) return;
      const c = loadEcharts().init(plotRef.current, `af-${theme}`, { renderer: 'svg' });
      instance.current = c;
      setReady(true);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => c.resize());
        observer.observe(plotRef.current);
      }
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
      setReady(false);
    };
    // The theme is applied by the effect below; re-creating the chart on theme change is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (ready) instance.current?.setOption(option, { notMerge: true });
  }, [ready, option]);

  useEffect(() => {
    if (ready) {
      instance.current?.setTheme(`af-${theme}`);
      instance.current?.setOption(option, { notMerge: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme]);

  return (
    <figure className={s.root({ className: ['m-0', className] })} aria-label={title}>
      <div className={s.bar()}>
        {series.length >= 2 ? (
          <ul className={s.legend()} aria-label="Legend">
            {series.map((sr, i) => (
              <li key={sr.name} className="inline-flex items-center gap-1.5">
                <span className={s.swatch({ className: SWATCH[i] })} aria-hidden />
                {sr.name}
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <SegmentedControl
          size="sm"
          aria-label={`${title}: view as`}
          value={view}
          onValueChange={(v) => setView(v as 'chart' | 'table')}
          options={[
            { value: 'chart', label: <ChartLineIcon size={14} aria-hidden />, 'aria-label': 'Chart' },
            { value: 'table', label: <TableIcon size={14} aria-hidden />, 'aria-label': 'Table' },
          ]}
        />
      </div>
      {view === 'chart' ? (
        <div className={s.plot()} style={{ height }}>
          {!ready && <Skeleton shape="block" className="absolute inset-0 h-full" />}
          <div
            ref={plotRef}
            className="size-full"
            role="img"
            aria-label={`${title}. Switch to the table view for exact values.`}
          />
        </div>
      ) : (
        <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label={`${title} data`}>
          <table className={s.table()}>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className={s.th()}>
                  {categoryLabel}
                </th>
                {series.map((sr) => (
                  <th key={sr.name} scope="col" className={s.th({ className: 'text-right' })}>
                    {sr.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat, row) => (
                <tr key={cat}>
                  <th scope="row" className={s.td({ className: 'font-medium text-fg' })}>
                    {cat}
                  </th>
                  {series.map((sr) => {
                    const v = sr.data[row];
                    return (
                      <td key={sr.name} className={s.td({ className: s.num() })}>
                        {v == null ? '—' : valueFormat(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
