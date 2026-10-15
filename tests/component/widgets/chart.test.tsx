import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WIDGETS,
  chartFixtures,
  foldSeries,
  prepareHeatGrid,
  prepareSeries,
  prepareSlices,
  type ChartConfig,
} from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { failed, loading, ready, renderWidget } from './helpers';

// The ECharts runtime is lazy-loaded; jsdom has no layout, so replace it with spies.
const runtime = vi.hoisted(() => {
  const instance = { setOption: vi.fn(), setTheme: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { instance, init: vi.fn(() => instance) };
});
vi.mock('../../../portal/packages/ui/src/lib/chart-runtime', () => ({ echarts: { init: runtime.init } }));

const Chart = WIDGETS.chart!.component;
const parse = (c: unknown) => WIDGETS.chart!.schema.parse(c) as ChartConfig;

describe('chart widget', () => {
  it('line: one series per y field, a legend, the provenance line and a Table toggle with exact values', async () => {
    const user = userEvent.setup();
    const { container } = renderWidget(Chart, parse(chartFixtures.signIns.config), ready(chartFixtures.signIns.rows));
    const figure = screen.getByRole('figure', { name: 'Sign-ins' });
    expect(within(figure).getByRole('list', { name: 'Legend' })).toHaveTextContent('Succeeded');
    expect(within(figure).getByRole('list', { name: 'Legend' })).toHaveTextContent('Failed');
    expect(screen.getByText('graph')).toBeInTheDocument();
    await user.click(within(figure).getByRole('radio', { name: 'Table' }));
    const table = within(figure).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(table).toHaveTextContent('4,200');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('donut: legend carries name, value and share; table view lists every slice', async () => {
    const user = userEvent.setup();
    const { container } = renderWidget(Chart, parse(chartFixtures.byPlatform.config), ready(chartFixtures.byPlatform.rows));
    const figure = screen.getByRole('figure', { name: 'Devices by platform' });
    expect(within(figure).getByRole('img', { name: /Windows 3,120/ })).toBeInTheDocument();
    const legend = within(figure).getByRole('list', { name: 'Legend' });
    expect(legend).toHaveTextContent('Windows');
    expect(legend).toHaveTextContent('63%');
    expect(figure).toHaveTextContent('4,972');
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(figure).getByRole('radio', { name: 'Table' }));
    expect(within(figure).getAllByRole('row')).toHaveLength(6);
  });

  it('heat grid is a real table; percent values format ×100', async () => {
    const config = parse({ ...chartFixtures.failuresByHour.config, format: 'percent' });
    const { container } = renderWidget(Chart, config, ready(chartFixtures.failuresByHour.rows.map((r) => ({ ...r, count: r.count / 100 }))));
    const table = screen.getByRole('table', { name: 'Failed sign-ins by hour' });
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Mon', 'Tue', 'Wed']);
    expect(table).toHaveTextContent('22%');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('loading skeleton, error with Try again, and the empty copy', async () => {
    const user = userEvent.setup();
    const config = parse(chartFixtures.signIns.config);
    const a = renderWidget(Chart, config, loading);
    expect(screen.getByText('Loading sign-ins')).toBeInTheDocument();
    a.unmount();
    const err = failed();
    const b = renderWidget(Chart, config, err);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-ins didn’t load');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(err.retry).toHaveBeenCalled();
    b.unmount();
    renderWidget(Chart, config, ready([]));
    expect(screen.getByText('Nothing to chart yet')).toBeInTheDocument();
  });
});

describe('chart data preparation', () => {
  it('splits rows into series by a field and keeps x order', () => {
    const config = parse({ widget: 'chart', type: 'stackedBar', data: 'a.value', x: 'product', series: 'severity', y: 'count' });
    const out = prepareSeries(
      [
        { product: 'Office 365', severity: 'High', count: 2 },
        { product: 'Office 365', severity: 'Low', count: 1 },
        { product: 'Identity', severity: 'High', count: 1 },
      ],
      config,
    );
    expect(out.categories).toEqual(['Office 365', 'Identity']);
    expect(out.series).toEqual([
      { name: 'High', data: [2, 1] },
      { name: 'Low', data: [1, null] },
    ]);
  });

  it('formats ISO date categories as short UTC dates', () => {
    const out = prepareSeries([{ d: '2026-10-14', n: 1 }, { d: '2026-10-15', n: 2 }], parse({ widget: 'chart', type: 'line', data: 'a.value', x: 'd', y: 'n' }));
    expect(out.categories).toEqual(['14 Oct', '15 Oct']);
  });

  it('folds more than six series (and donut slices) into “Other”', () => {
    const series = Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, data: [i + 1] }));
    const folded = foldSeries(series);
    expect(folded).toHaveLength(6);
    expect(folded.at(-1)).toEqual({ name: 'Other', data: [1 + 2 + 3] });
    const slices = prepareSlices(
      Array.from({ length: 8 }, (_, i) => ({ k: `K${i}`, v: i + 1 })),
      parse({ widget: 'chart', type: 'donut', data: 'a.value', x: 'k', y: 'v' }),
    );
    expect(slices).toHaveLength(6);
    expect(slices.at(-1)).toEqual({ name: 'Other', value: 1 + 2 + 3 });
  });

  it('heat grid sums duplicates and tracks the max', () => {
    const grid = prepareHeatGrid(
      [
        { d: 'Mon', h: '00', n: 1 },
        { d: 'Mon', h: '00', n: 2 },
        { d: 'Tue', h: '04', n: 5 },
      ],
      parse({ widget: 'chart', type: 'heatGrid', data: 'a.value', x: 'h', series: 'd', y: 'n' }),
    );
    expect(grid.columns).toEqual(['00', '04']);
    expect(grid.rows).toEqual([
      { name: 'Mon', values: [3, null] },
      { name: 'Tue', values: [null, 5] },
    ]);
    expect(grid.max).toBe(5);
  });
});
