import { PORTAL_MIN_INTERVAL_MS, runsTooOften } from '@adminforge/api/src/schedules/cron';

// Report schedules created in the portal run at most hourly: no two runs closer than 60 minutes over ~8 days of runs,
// counted from the first run (so a pattern limited to a later month is judged on the days it runs).

const NOW = new Date('2026-10-15T12:00:00Z');

describe('runsTooOften (at most hourly)', () => {
  it.each([
    ['0 * * * *', 'UTC'],
    ['@hourly', 'UTC'],
    ['15 * * * *', 'Europe/London'],
    ['0 6 * * *', 'UTC'],
    ['0 6 * * 1-5', 'America/New_York'],
    ['30 6 * * 1', 'Europe/London'],
    ['0 6 1 * *', 'UTC'],
    ['@daily', 'UTC'],
    ['0 6,7 * * *', 'UTC'],
    ['50 23,0 * * *', 'UTC'],
    ['0 0 */2 * * *', 'UTC'],
    // Never fires again (30 February): nothing to run too often.
    ['0 0 30 2 *', 'UTC'],
  ])('allows %s (%s)', (cron, tz) => expect(runsTooOften(cron, tz, NOW)).toBe(false));

  it.each([
    ['*/15 * * * *', 'UTC'],
    ['*/30 * * * *', 'UTC'],
    ['* * * * *', 'UTC'],
    ['0,30 6 * * 1', 'Europe/London'],
    ['0,59 * * * *', 'UTC'],
    ['5,10 9 * * *', 'UTC'],
    // Only in December, but every minute then.
    ['* * * 12 *', 'UTC'],
    // Six fields (seconds first): twice a minute during minute 0.
    ['0,30 0 * * * *', 'UTC'],
    ['*/10 * * * * *', 'UTC'],
  ])('refuses %s (%s)', (cron, tz) => expect(runsTooOften(cron, tz, NOW)).toBe(true));

  it('takes a different minimum interval', () => {
    expect(runsTooOften('0 */6 * * *', 'UTC', NOW, 6 * PORTAL_MIN_INTERVAL_MS)).toBe(false);
    expect(runsTooOften('0 */4 * * *', 'UTC', NOW, 6 * PORTAL_MIN_INTERVAL_MS)).toBe(true);
  });

  it('throws on an invalid pattern (validate it first)', () => {
    expect(() => runsTooOften('61 * * * *', 'UTC', NOW)).toThrow();
  });
});
