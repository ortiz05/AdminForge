import { describeCron, nextRun, nextRuns } from '@adminforge/api/src/schedules/cron';
import { retryDelayMs } from '@adminforge/api/src/schedules/scheduler';

const at = (s: string) => new Date(s);

describe('nextRun', () => {
  it('computes the next tick in UTC', () => {
    expect(nextRun('*/15 * * * *', 'UTC', at('2026-10-15T12:07:30Z'))?.toISOString()).toBe(
      '2026-10-15T12:15:00.000Z',
    );
    expect(nextRun('7 * * * *', 'UTC', at('2026-10-15T12:07:00Z'))?.toISOString()).toBe(
      '2026-10-15T13:07:00.000Z',
    );
    expect(nextRun('20 */6 * * *', 'UTC', at('2026-10-15T12:30:00Z'))?.toISOString()).toBe(
      '2026-10-15T18:20:00.000Z',
    );
    expect(nextRun('@daily', 'UTC', at('2026-10-15T12:00:00Z'))?.toISOString()).toBe(
      '2026-10-16T00:00:00.000Z',
    );
  });
  it('honours the schedule time zone, including DST changes', () => {
    // 07:00 Europe/London is 06:00 UTC in summer time and 07:00 UTC after the clocks go back (25 Oct 2026).
    expect(nextRun('0 7 * * *', 'Europe/London', at('2026-10-15T12:00:00Z'))?.toISOString()).toBe(
      '2026-10-16T06:00:00.000Z',
    );
    expect(nextRun('0 7 * * *', 'Europe/London', at('2026-10-25T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-25T07:00:00.000Z',
    );
    expect(nextRun('0 9 * * 1-5', 'America/New_York', at('2026-10-16T14:00:00Z'))?.toISOString()).toBe(
      '2026-10-19T13:00:00.000Z',
    );
  });
  it('supports last-day and nth-weekday patterns', () => {
    expect(nextRun('0 9 L * *', 'UTC', at('2026-10-15T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-31T09:00:00.000Z',
    );
    expect(nextRun('0 9 * * MON#1', 'UTC', at('2026-10-15T00:00:00Z'))?.toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    );
  });
  it('lists several runs', () =>
    expect(
      nextRuns('0 */12 * * *', 'UTC', at('2026-10-15T01:00:00Z'), 3).map((d) => d.toISOString()),
    ).toEqual(['2026-10-15T12:00:00.000Z', '2026-10-16T00:00:00.000Z', '2026-10-16T12:00:00.000Z']));
});

describe('describeCron (the shared describer, 24-hour, naming the zone when given)', () => {
  it.each([
    ['*/15 * * * *', 'Every 15 minutes'],
    ['* * * * *', 'Every minute'],
    ['7 * * * *', 'Every hour at :07'],
    ['0 * * * *', 'Every hour, on the hour'],
    ['20 */6 * * *', 'Every 6 hours at :20'],
    ['15 5 * * *', 'Every day at 05:15'],
    ['0 6,18 * * *', 'Every day at 06:00 and 18:00'],
    ['0 7 * * 1', 'Every Monday at 07:00'],
    ['0 7 * * 1-5', 'Every weekday (Mon–Fri) at 07:00'],
    ['0 7 * * MON,THU', 'Every Monday and Thursday at 07:00'],
    ['0 7 1 * *', 'On the 1st of every month at 07:00'],
    ['0 7 L * *', 'On the last day of every month at 07:00'],
    ['30 8 * * 1#1', 'On the first Monday of every month at 08:30'],
    ['@weekly', 'Every Sunday at 00:00'],
    ['0 0 7 * * 1', 'Every Monday at 07:00'],
  ])('%s → %s', (cron, text) => expect(describeCron(cron)).toBe(text));
  it('names the zone when one is given', () => {
    expect(describeCron('0 7 * * 1-5', 'Europe/London')).toBe(
      'Every weekday (Mon–Fri) at 07:00 Europe/London',
    );
    expect(describeCron('*/15 * * * *', 'UTC')).toBe('Every 15 minutes (UTC)');
  });
  it.each(['0 0 1 JAN,JUL ?', '0-30/10 8-18 1-15 * 0,6', '30 0 7 * * *'])('returns null for %s', (cron) =>
    expect(describeCron(cron)).toBeNull(),
  );
});

describe('retry delays', () => {
  it('doubles exponentially from the configured delay and caps at 6 hours', () => {
    const r = { max: 5, backoff: 'exponential' as const, delay: '5m' };
    expect([1, 2, 3].map((a) => retryDelayMs(r, a))).toEqual([300_000, 600_000, 1_200_000]);
    expect(retryDelayMs({ ...r, delay: 'PT4H' }, 3)).toBe(6 * 3_600_000);
  });
  it('keeps a fixed delay and defaults to one second', () => {
    expect(retryDelayMs({ max: 3, backoff: 'fixed', delay: '10m' }, 3)).toBe(600_000);
    expect(retryDelayMs({ max: 3, backoff: 'exponential' }, 1)).toBe(1_000);
  });
});
