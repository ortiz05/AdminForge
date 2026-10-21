import { render, waitFor } from '@testing-library/react';
import { Chart } from '@adminforge/ui';

// D-12: charts of small counts drew fractional, colliding value-axis ticks (0 0.2 0.4 … 1). Whole-number data steps by
// whole numbers; labels that would collide are dropped; a value axis with less than ~160 px to run along shows no
// labels at all (the tooltip and the table view still give every value).

const runtime = vi.hoisted(() => {
  const instance = { setOption: vi.fn(), setTheme: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { instance, init: vi.fn(() => instance) };
});
vi.mock('../../../portal/packages/ui/src/lib/chart-runtime', () => ({
  loadEcharts: () => ({ init: runtime.init }),
}));

interface Axis {
  type: string;
  minInterval?: number;
  axisLabel: { show?: boolean; hideOverlap?: boolean; formatter: (v: number) => string };
}
const lastOption = () => runtime.instance.setOption.mock.calls.at(-1)![0] as { xAxis: Axis; yAxis: Axis };

/** A ResizeObserver that reports `width` for the plot as soon as it is observed (jsdom has no layout). */
function plotWidth(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

beforeEach(() => {
  runtime.init.mockClear();
  Object.values(runtime.instance).forEach((fn) => fn.mockClear());
});
afterEach(() => vi.unstubAllGlobals());

const DOMAINS = ['partner.example', 'contoso.example', 'fabrikam.example'];

describe('Chart value axis', () => {
  it('steps by whole numbers when every value is a whole number (horizontal bars)', async () => {
    render(
      <Chart
        title="Top home domains"
        kind="bar"
        horizontal
        categories={DOMAINS}
        series={[{ name: 'Guests', data: [1, 1, 1] }]}
      />,
    );
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    const { xAxis, yAxis } = lastOption();
    expect(xAxis.type).toBe('value');
    expect(xAxis.minInterval).toBe(1);
    expect(xAxis.axisLabel.hideOverlap).toBe(true);
    expect(yAxis.minInterval).toBeUndefined();
  });

  it('steps by whole numbers on a vertical value axis too, nulls aside', async () => {
    render(
      <Chart
        title="Sign-ins per day"
        kind="line"
        categories={['2 Oct', '3 Oct', '4 Oct']}
        series={[{ name: 'Failures', data: [0, null, 3] }]}
      />,
    );
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    expect(lastOption().yAxis).toMatchObject({ type: 'value', minInterval: 1 });
  });

  it('leaves fractional data to the default ticks', async () => {
    render(
      <Chart
        title="Failure rate"
        kind="line"
        categories={['2 Oct', '3 Oct']}
        series={[{ name: 'Rate', data: [0.4, 1.25] }]}
      />,
    );
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    expect(lastOption().yAxis.minInterval).toBeUndefined();
  });

  it('labels the value axis with grouped whole numbers', async () => {
    render(
      <Chart
        title="Devices by platform"
        kind="bar"
        categories={['Windows', 'macOS']}
        series={[{ name: 'Devices', data: [2140, 612] }]}
      />,
    );
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    const { formatter } = lastOption().yAxis.axisLabel;
    expect(formatter(1000)).toBe('1,000');
    expect(formatter(2)).toBe('2');
  });

  it('shows the value-axis labels when the plot is wide enough', async () => {
    plotWidth(480);
    render(
      <Chart
        title="Top home domains"
        kind="bar"
        horizontal
        categories={DOMAINS}
        series={[{ name: 'Guests', data: [3, 2, 1] }]}
      />,
    );
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    expect(lastOption().xAxis.axisLabel.show).not.toBe(false);
  });

  it('hides the value-axis labels when the bars have less than ~160 px to run along', async () => {
    // 260 px wide, but the domain names beside the bars take about half of it.
    plotWidth(260);
    render(
      <Chart
        title="Top home domains"
        kind="bar"
        horizontal
        categories={DOMAINS}
        series={[{ name: 'Guests', data: [3, 2, 1] }]}
      />,
    );
    await waitFor(() => expect(lastOption().xAxis.axisLabel.show).toBe(false));
    // The category labels stay: they name the bars.
    expect(lastOption().yAxis.axisLabel.show).not.toBe(false);
  });

  it('hides the value-axis labels of a vertical chart narrower than ~160 px', async () => {
    plotWidth(140);
    render(
      <Chart
        title="Sign-ins per day"
        kind="line"
        categories={['2 Oct', '3 Oct']}
        series={[{ name: 'Failures', data: [2, 5] }]}
      />,
    );
    await waitFor(() => expect(lastOption().yAxis.axisLabel.show).toBe(false));
  });
});
