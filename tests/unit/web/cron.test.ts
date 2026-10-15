import { describeCron, formatInZone, nextRuns } from '@adminforge/web/src/ops/cron';

describe('describeCron', () => {
  it.each([
    ['0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['0 6 * * *', 'Europe/London', 'Every day at 06:00 Europe/London'],
    ['*/5 * * * *', 'UTC', 'Every 5 minutes'],
    ['30 * * * *', 'UTC', 'Every hour at 30 past'],
    ['0 * * * *', 'UTC', 'Every hour, on the hour'],
    ['0 */4 * * *', 'UTC', 'Every 4 hours, on the hour'],
    ['0 8 * * 1-5', 'UTC', 'Every weekday (Mon–Fri) at 08:00 UTC'],
    ['15 2 * * 1,3,5', 'UTC', 'Every Mon, Wed and Fri at 02:15 UTC'],
    ['5 4 * * sun', 'UTC', 'Every Sunday at 04:05 UTC'],
    ['0 9 1 * *', 'UTC', 'On the 1st of every month at 09:00 UTC'],
    ['0 0 L * *', 'UTC', 'On the last day of every month at 00:00 UTC'],
    ['0 0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['@daily', 'UTC', 'Every day at 00:00 UTC'],
    ['0 9 1 1 *', 'America/New_York', 'Every year on 1 January at 09:00 America/New York'],
    ['0 9 * 1 2#1', 'UTC', 'Custom: 0 9 * 1 2#1'],
  ])('%s (%s) → %s', (cron, tz, text) => expect(describeCron(cron, tz)).toBe(text));
});

describe('nextRuns', () => {
  const from = new Date('2026-10-15T14:00:00.000Z');
  it('computes upcoming runs in the schedule’s time zone', () => {
    expect(nextRuns('0 7 * * 1', 'UTC', 2, from).map((d) => d.toISOString())).toEqual([
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T07:00:00.000Z',
    ]);
    // 07:00 London is 06:00 UTC in summer time and 07:00 after the clocks go back (25 Oct 2026).
    expect(nextRuns('0 7 * * 1', 'Europe/London', 2, from).map((d) => d.toISOString())).toEqual([
      '2026-10-19T06:00:00.000Z',
      '2026-10-26T07:00:00.000Z',
    ]);
  });
  it('returns nothing for an invalid expression', () =>
    expect(nextRuns('not cron', 'UTC', 3, from)).toEqual([]));
  it('formats in the zone', () =>
    expect(formatInZone('2026-10-19T06:00:00.000Z', 'Europe/London')).toBe('Mon 19 Oct, 07:00'));
});
