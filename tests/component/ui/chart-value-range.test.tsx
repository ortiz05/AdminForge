import { render, waitFor } from '@testing-library/react';
import { Chart } from '@adminforge/ui';

// A share runs 0–100 whatever the data: `valueRange` fixes the value axis, so a line of 30 % doesn't fill the plot
// as if it were the top (Monitoring's "checks passing, per hour"). Without it the axis follows the data.

const runtime = vi.hoisted(() => {
  const instance = { setOption: vi.fn(), setTheme: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
  return { instance, init: vi.fn(() => instance) };
});
vi.mock('../../../portal/packages/ui/src/lib/chart-runtime', () => ({
  loadEcharts: () => ({ init: runtime.init }),
}));

const lastOption = () =>
  runtime.instance.setOption.mock.calls.at(-1)![0] as { yAxis: { min?: number; max?: number } };

beforeEach(() => {
  runtime.init.mockClear();
  Object.values(runtime.instance).forEach((fn) => fn.mockClear());
});

describe('Chart valueRange', () => {
  it('fixes the value axis when given, and leaves it to the data otherwise', async () => {
    const props = {
      title: 'Passing',
      kind: 'line' as const,
      categories: ['a', 'b'],
      series: [{ name: 'Passing', data: [30, 0] }],
    };
    const { rerender } = render(<Chart {...props} valueRange={{ min: 0, max: 100 }} />);
    await waitFor(() => expect(runtime.instance.setOption).toHaveBeenCalled());
    expect(lastOption().yAxis).toMatchObject({ min: 0, max: 100 });
    rerender(<Chart {...props} />);
    await waitFor(() => expect(lastOption().yAxis.max).toBeUndefined());
    expect(lastOption().yAxis.min).toBeUndefined();
  });
});
