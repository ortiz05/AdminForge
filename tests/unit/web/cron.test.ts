import { describeCron, formatInZone, nextRuns, timeZoneList, zoneOffset } from '@adminforge/web/src/ops/cron';

// The web app's cron helpers: the shared describer (@adminforge/schemas cadence.ts; its own tests cover the grammar)
// with the browser's clock, next runs for lists, and the time zone list behind the searchable picker.
describe('describeCron', () => {
  it.each([
    ['0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['0 6 * * *', 'Europe/London', 'Every day at 06:00 Europe/London'],
    ['*/5 * * * *', 'UTC', 'Every 5 minutes (UTC)'],
    ['30 * * * *', 'UTC', 'Every hour at :30 (UTC)'],
    ['0 * * * *', 'UTC', 'Every hour, on the hour (UTC)'],
    ['0 */4 * * *', 'UTC', 'Every 4 hours, on the hour (UTC)'],
    ['0 8 * * 1-5', 'UTC', 'Every weekday (Mon–Fri) at 08:00 UTC'],
    ['15 2 * * 1,3,5', 'UTC', 'Every Monday, Wednesday and Friday at 02:15 UTC'],
    ['5 4 * * sun', 'UTC', 'Every Sunday at 04:05 UTC'],
    ['0 9 1 * *', 'UTC', 'On the 1st of every month at 09:00 UTC'],
    ['0 0 L * *', 'UTC', 'On the last day of every month at 00:00 UTC'],
    ['30 8 * * 1#1', 'UTC', 'On the first Monday of every month at 08:30 UTC'],
    ['0 17 * * 5L', 'UTC', 'On the last Friday of every month at 17:00 UTC'],
    ['0 0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['@daily', 'UTC', 'Every day at 00:00 UTC'],
    ['0 9 1 1 *', 'America/New_York', 'Every year on 1 January at 09:00 America/New York'],
    ['0 9 * 1 2#1', 'UTC', 'Custom: 0 9 * 1 2#1'],
  ])('%s (%s) → %s', (cron, tz, text) => expect(describeCron(cron, tz, { hour12: false })).toBe(text));

  it('follows the browser’s clock unless told otherwise (this test runs as en-US: 12-hour)', () => {
    expect(describeCron('0 7 * * 1', 'UTC', { hour12: true })).toBe('Every Monday at 7:00 am UTC');
    expect(describeCron('0 19 * * 1')).toBe(
      describeCron('0 19 * * 1', 'UTC', {
        hour12: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle !== 'h23',
      }),
    );
  });
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
  it('formats in the zone, with a 24- or 12-hour clock', () => {
    expect(formatInZone('2026-10-19T06:00:00.000Z', 'Europe/London', { hour12: false })).toBe(
      'Mon 19 Oct, 07:00',
    );
    expect(formatInZone('2026-10-19T18:30:00.000Z', 'Europe/London', { hour12: true })).toMatch(
      /^Mon 19 Oct, 7:30\s?pm$/,
    );
  });
});

describe('time zones', () => {
  it('lists UTC first, then the browser’s zone and every IANA zone, without duplicates', () => {
    const zones = timeZoneList('America/Argentina/Buenos_Aires');
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain('Europe/London');
    expect(zones).toContain('America/Argentina/Buenos_Aires');
    expect(zones.length).toBeGreaterThan(300);
    expect(new Set(zones).size).toBe(zones.length);
  });
  it('shows the current offset', () => {
    expect(zoneOffset('UTC')).toMatch(/^UTC/);
    expect(zoneOffset('Asia/Kolkata', new Date('2026-01-15T00:00:00Z'))).toBe('UTC+05:30');
    expect(zoneOffset('Europe/London', new Date('2026-07-01T00:00:00Z'))).toBe('UTC+01:00');
  });
});
