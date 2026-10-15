import { DAY, ago } from '../../lib/fixtures';
import type { ChartConfig } from './schema';

const days = Array.from({ length: 7 }, (_, i) => ago((6 - i) * DAY).slice(0, 10));

/** Story data for the chart widget. */
export const chartFixtures = {
  signIns: {
    config: {
      widget: 'chart',
      title: 'Sign-ins',
      type: 'line',
      data: 'signins.value',
      x: 'day',
      y: ['succeeded', 'failed'],
    } satisfies ChartConfig,
    rows: days.map((day, i) => ({
      day,
      succeeded: 4200 + i * 130 - (i % 3) * 210,
      failed: 120 + (i % 4) * 35,
    })),
  },
  byPlatform: {
    config: {
      widget: 'chart',
      title: 'Devices by platform',
      type: 'donut',
      data: 'devices.value',
      x: 'platform',
      y: 'count',
    } satisfies ChartConfig,
    rows: [
      { platform: 'Windows', count: 3120 },
      { platform: 'macOS', count: 640 },
      { platform: 'iOS', count: 820 },
      { platform: 'Android', count: 380 },
      { platform: 'Linux', count: 12 },
    ],
  },
  failuresByHour: {
    config: {
      widget: 'chart',
      title: 'Failed sign-ins by hour',
      type: 'heatGrid',
      data: 'failures.value',
      x: 'hour',
      series: 'day',
      y: 'count',
    } satisfies ChartConfig,
    rows: ['Mon', 'Tue', 'Wed'].flatMap((day, d) =>
      ['00', '04', '08', '12', '16', '20'].map((hour, h) => ({ day, hour, count: (d * 7 + h * 11) % 40 })),
    ),
  },
};
