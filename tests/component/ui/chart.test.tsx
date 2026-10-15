import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chart } from '@adminforge/ui';
import { axeViolations } from '../axe';

// The ECharts runtime is lazy-loaded; replace it with spies (jsdom has no layout or canvas).
const runtime = vi.hoisted(() => {
  const instance = { setOption: vi.fn(), setTheme: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { instance, init: vi.fn(() => instance) };
});
vi.mock('../../../portal/packages/ui/src/lib/chart-runtime', () => ({
  loadEcharts: () => ({ init: runtime.init }),
}));

const CATEGORIES = ['2 Oct', '3 Oct', '4 Oct'];
const TWO = [
  { name: 'Interactive', data: [4120, 4380, null] },
  { name: 'Non-interactive', data: [9800, 10240, 10110] },
];

beforeEach(() => {
  runtime.init.mockClear();
  Object.values(runtime.instance).forEach((fn) => fn.mockClear());
  document.documentElement.removeAttribute('data-theme');
});

describe('Chart', () => {
  it('is a figure named by its title; ≥2 series get a legend', async () => {
    const { container } = render(
      <Chart title="Sign-ins per day" kind="line" categories={CATEGORIES} series={TWO} />,
    );
    const figure = screen.getByRole('figure', { name: 'Sign-ins per day' });
    const legend = within(figure).getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Interactive', 'Non-interactive']);
    await waitFor(() => expect(runtime.init).toHaveBeenCalled());
    expect(within(figure).getByRole('img', { name: /Sign-ins per day/ })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('a single series has no legend box', () => {
    render(
      <Chart
        title="Devices by platform"
        kind="bar"
        categories={['Windows', 'macOS']}
        series={[{ name: 'Devices', data: [2140, 612] }]}
      />,
    );
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
  });

  it('initialises with the steel theme and sends series options', async () => {
    render(<Chart title="Sign-ins per day" kind="area" categories={CATEGORIES} series={TWO} />);
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    expect(runtime.init).toHaveBeenCalledWith(expect.any(HTMLElement), 'af-steel', { renderer: 'svg' });
    const option = runtime.instance.setOption.mock.calls.at(-1)![0] as {
      series: Array<{ type: string; name: string; areaStyle?: unknown }>;
      xAxis: { data: string[] };
    };
    expect(option.series.map((s) => [s.type, s.name])).toEqual([
      ['line', 'Interactive'],
      ['line', 'Non-interactive'],
    ]);
    expect(option.series[0]!.areaStyle).toBeDefined();
    expect(option.xAxis.data).toEqual(CATEGORIES);
  });

  it('follows <html data-theme> changes', async () => {
    render(<Chart title="Sign-ins per day" kind="line" categories={CATEGORIES} series={TWO} />);
    await waitFor(() => expect(runtime.init).toHaveBeenCalled());
    act(() => {
      document.documentElement.dataset.theme = 'daylight';
    });
    await waitFor(() => expect(runtime.instance.setTheme).toHaveBeenCalledWith('af-daylight'));
  });

  it('starts in the theme already on <html>', async () => {
    document.documentElement.dataset.theme = 'contrast';
    render(<Chart title="Latency" kind="line" categories={CATEGORIES} series={TWO} />);
    await waitFor(() =>
      expect(runtime.init).toHaveBeenCalledWith(expect.any(HTMLElement), 'af-contrast', { renderer: 'svg' }),
    );
  });

  it('the Table toggle shows the data as a captioned table with formatted values; the chart is disposed', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Chart title="Sign-ins per day" kind="line" categories={CATEGORIES} series={TWO} categoryLabel="Day" />,
    );
    await waitFor(() => expect(runtime.init).toHaveBeenCalled());
    const views = screen.getByRole('radiogroup', { name: 'Sign-ins per day: view as' });
    await user.click(within(views).getByRole('radio', { name: 'Table' }));
    const table = screen.getByRole('table', { name: 'Sign-ins per day' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Day', 'Interactive', 'Non-interactive']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('2 Oct4,1209,800');
    expect(rows[2]).toHaveTextContent('4 Oct—10,110');
    expect(runtime.instance.dispose).toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Sign-ins per day data' })).toHaveAttribute('tabindex', '0');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('uses a custom value format in the table', async () => {
    const user = userEvent.setup();
    render(
      <Chart
        title="Latency"
        kind="bar"
        categories={['Graph']}
        series={[{ name: 'p50', data: [182] }]}
        valueFormat={(v) => `${v} ms`}
        defaultView="table"
      />,
    );
    expect(screen.getByRole('table', { name: 'Latency' })).toHaveTextContent('182 ms');
    await user.click(screen.getByRole('radio', { name: 'Chart' }));
    await waitFor(() => expect(runtime.init).toHaveBeenCalled());
  });

  it('caps at six series (fixed palette order, never cycled)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `S${i + 1}`, data: [i] }));
    render(<Chart title="Many" kind="line" categories={['a']} series={many} />);
    expect(within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem')).toHaveLength(6);
  });
});
