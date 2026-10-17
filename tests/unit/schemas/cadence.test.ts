import { nextRuns } from '@adminforge/api/src/schedules/cron';
import { describeCron, parseSchedule, splitTrailingZone, type ParsedSchedule } from '@adminforge/schemas';

// Schedule times in plain English (portal/packages/schemas/src/cadence.ts): one describer for the API's cronText, the
// schedule list and the editors, and the closed grammar behind the editor's "Type it in English" box and content YAML's
// `every:`. Next runs come from the scheduler's own helper (apps/api schedules/cron.ts, croner), checked across
// daylight-saving changes.

const cronOf = (r: ParsedSchedule) => (r.ok ? r.cron : `error: ${r.error}`);

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'UTC', 'Every minute (UTC)'],
    ['*/15 * * * *', 'UTC', 'Every 15 minutes (UTC)'],
    ['0 * * * *', 'UTC', 'Every hour, on the hour (UTC)'],
    ['20 * * * *', 'Europe/London', 'Every hour at :20 (Europe/London)'],
    ['0 */4 * * *', 'UTC', 'Every 4 hours, on the hour (UTC)'],
    ['20 0/6 * * *', 'UTC', 'Every 6 hours at :20 (UTC)'],
    ['0 6 * * *', 'Europe/London', 'Every day at 06:00 Europe/London'],
    ['0 7,19 * * *', 'UTC', 'Every day at 07:00 and 19:00 UTC'],
    ['0 8 * * 1-5', 'UTC', 'Every weekday (Mon–Fri) at 08:00 UTC'],
    ['30 2 * * MON-FRI', 'UTC', 'Every weekday (Mon–Fri) at 02:30 UTC'],
    ['0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['15 2 * * 1,3,5', 'UTC', 'Every Monday, Wednesday and Friday at 02:15 UTC'],
    ['0 9 * * 0,6', 'UTC', 'Every Saturday and Sunday at 09:00 UTC'],
    ['5 4 * * sun', 'UTC', 'Every Sunday at 04:05 UTC'],
    ['5 4 * * 7', 'UTC', 'Every Sunday at 04:05 UTC'],
    ['30 8 15 * *', 'UTC', 'On the 15th of every month at 08:30 UTC'],
    ['30 8 1 * *', 'UTC', 'On the 1st of every month at 08:30 UTC'],
    ['30 8 * * 1#1', 'Europe/London', 'On the first Monday of every month at 08:30 Europe/London'],
    ['0 9 * * MON#3', 'UTC', 'On the third Monday of every month at 09:00 UTC'],
    ['0 17 * * 5L', 'UTC', 'On the last Friday of every month at 17:00 UTC'],
    ['0 23 L * *', 'UTC', 'On the last day of every month at 23:00 UTC'],
    ['0 9 1 1 *', 'America/New_York', 'Every year on 1 January at 09:00 America/New York'],
    ['0 0 7 * * 1', 'UTC', 'Every Monday at 07:00 UTC'],
    ['@daily', 'UTC', 'Every day at 00:00 UTC'],
    ['@hourly', 'UTC', 'Every hour, on the hour (UTC)'],
    ['0 9 * 1 2#1', 'UTC', 'Custom: 0 9 * 1 2#1'],
    ['0 9-17 * * 1-5', 'UTC', 'Custom: 0 9-17 * * 1-5'],
    ['0 9 1-7 * 1', 'UTC', 'Custom: 0 9 1-7 * 1'],
  ])('%s (%s) → %s', (cron, timezone, text) => expect(describeCron(cron, { timezone })).toBe(text));

  it('12-hour clock: am/pm, noon and midnight', () => {
    const h12 = (cron: string) => describeCron(cron, { timezone: 'America/New_York', hour12: true });
    expect(h12('0 7 * * 1-5')).toBe('Every weekday (Mon–Fri) at 7:00 am America/New York');
    expect(h12('45 18 * * 5')).toBe('Every Friday at 6:45 pm America/New York');
    expect(h12('0 12 * * *')).toBe('Every day at 12:00 pm America/New York');
    expect(h12('0 0 * * *')).toBe('Every day at 12:00 am America/New York');
    expect(h12('0 7,19 * * *')).toBe('Every day at 7:00 am and 7:00 pm America/New York');
  });

  it('leaves the zone out only when none is given (the text that goes into content YAML `every:`)', () => {
    expect(describeCron('0 7 * * 1-5')).toBe('Every weekday (Mon–Fri) at 07:00');
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
  });
});

describe('parseSchedule', () => {
  it.each([
    ['every weekday at 7:00 am', '0 7 * * 1-5'],
    ['weekdays 7am', '0 7 * * 1-5'],
    ['Monday to Friday at 6:45 pm', '45 18 * * 1-5'],
    ['every Monday at 08:30', '30 8 * * 1'],
    ['mondays at 8.30', '30 8 * * 1'],
    ['mon, wed and fri at 18:00', '0 18 * * 1,3,5'],
    ['Tuesday and Thursday at 9am', '0 9 * * 2,4'],
    ['weekends at 10:00', '0 10 * * 0,6'],
    ['first Monday of the month at 8:30', '30 8 * * 1#1'],
    ['second Tuesday of every month at 09:00', '0 9 * * 2#2'],
    ['monthly on the 3rd wednesday at 14:00', '0 14 * * 3#3'],
    ['last Friday of the month at 17:00', '0 17 * * 5L'],
    ['last Friday at 17:00', '0 17 * * 5L'],
    ['first Monday at 8:00', '0 8 * * 1#1'],
    ['on the 15th at 06:00', '0 6 15 * *'],
    ['last day of the month at 23:00', '0 23 L * *'],
    ['first day of every month at 06:00', '0 6 1 * *'],
    ['on the 15th of every month at 06:00', '0 6 15 * *'],
    ['every month on day 10 at 7:30am', '30 7 10 * *'],
    ['every 4 hours', '0 */4 * * *'],
    ['every 6 hours at :20', '20 */6 * * *'],
    ['every hour', '0 * * * *'],
    ['hourly at 15 past', '15 * * * *'],
    ['every hour at :45', '45 * * * *'],
    ['every 15 minutes', '*/15 * * * *'],
    ['every half hour', '*/30 * * * *'],
    ['every minute', '* * * * *'],
    ['daily at noon', '0 12 * * *'],
    ['every day at midnight', '0 0 * * *'],
    ['every night at 11pm', '0 23 * * *'],
    ['at 07:00 and 19:00', '0 7,19 * * *'],
    ['at 7', '0 7 * * *'],
    ['at 7 o’clock on Sundays', '0 7 * * 0'],
    ['every year on 1 January at 09:00', '0 9 1 1 *'],
    ['yearly on March 15th at noon', '0 12 15 3 *'],
    ['0 7 * * 1-5', '0 7 * * 1-5'],
    ['@daily', '0 0 * * *'],
  ])('“%s” → %s', (text, cron) => expect(cronOf(parseSchedule(text))).toBe(cron));

  it('splitTrailingZone keeps the rest as typed', () => {
    expect(splitTrailingZone('first Monday at 8:30 Europe/London')).toEqual({
      text: 'first Monday at 8:30',
      timezone: 'Europe/London',
    });
    expect(splitTrailingZone('Every 15 minutes (UTC).')).toEqual({
      text: 'Every 15 minutes',
      timezone: 'UTC',
    });
    expect(splitTrailingZone('every Monday at 07:00')).toEqual({ text: 'every Monday at 07:00' });
    expect(splitTrailingZone('daily at 7 Mars/Olympus')).toEqual({
      text: 'daily at 7 Mars/Olympus',
      unknownZone: 'Mars/Olympus',
    });
  });

  it('takes a time zone at the end and returns it separately (any case, the describer’s own label too)', () => {
    expect(parseSchedule('every weekday at 7:00 am europe/london')).toEqual({
      ok: true,
      cron: '0 7 * * 1-5',
      timezone: 'Europe/London',
    });
    expect(parseSchedule('Every day at 06:00 America/New York')).toMatchObject({
      timezone: 'America/New_York',
    });
    expect(parseSchedule('Every 15 minutes (UTC)')).toMatchObject({ cron: '*/15 * * * *', timezone: 'UTC' });
    expect(parseSchedule('every day at 7:00 Mars/Olympus')).toEqual({
      ok: false,
      error: '“Mars/Olympus” isn’t a time zone AdminForge knows. Choose the zone separately.',
    });
  });

  it.each([
    ['', /Type when it should run/],
    ['every tuesdy at 7', /Didn’t understand “tuesdy”/],
    ['every weekday at 7:00 sharp', /Didn’t understand “sharp”/],
    ['every Monday', /Add a time/],
    ['every 7 minutes', /doesn’t divide the hour evenly/],
    ['every 5 hours', /doesn’t divide the day evenly/],
    ['every 15 minutes on weekdays', /can’t be combined with days or times/],
    ['every 4 hours at 7:00', /counts from midnight/],
    ['61 * * * *', /minute "61" is out of range/],
    ['every month at 06:00', /Which day of the month/],
    ['first Monday and Friday of the month at 9:00', /not both/],
    ['the 1st of the month and Mondays at 9:00', /not both/],
    ['at 07:00 and 19:30', /same minutes/],
    ['at 13pm', /hour is 1 to 12/],
    ['at 25:00', /isn’t a time of day/],
    ['on the 32nd of every month at 9:00', /isn’t a day of the month/],
    [':15 on Mondays', /goes with “every hour”/],
  ])('refuses “%s”', (text, message) => {
    const r = parseSchedule(text);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(message);
  });

  it('never builds a day-of-month + day-of-week pair (cron would run when EITHER matches)', () => {
    for (const text of [
      'first Monday of the month at 8:30',
      'last Friday of the month at 17:00',
      'weekdays at 9:00',
    ])
      expect(cronOf(parseSchedule(text)).split(' ')[2]).toBe('*');
  });
});

describe('round trip: parseSchedule(describeCron(cron)) is the same cron for every shape the editors build', () => {
  const shapes = [
    '* * * * *',
    '*/5 * * * *',
    '*/30 * * * *',
    '0 * * * *',
    '20 * * * *',
    '0 */2 * * *',
    '20 */6 * * *',
    '0 7 * * *',
    '0 7,19 * * *',
    '15 6 * * 1-5',
    '0 18 * * 1,3,5',
    '0 9 * * 0,6',
    '5 4 * * 0',
    '30 8 15 * *',
    '0 9 31 * *',
    '30 8 * * 1#1',
    '0 9 * * 4#4',
    '0 17 * * 5L',
    '0 23 L * *',
    '0 0 1 1 *',
  ];
  it.each(shapes.flatMap((c) => [true, false].map((hour12) => [c, hour12] as const)))(
    '%s (12-hour: %s)',
    (cron, hour12) => {
      for (const timezone of ['UTC', 'Europe/London', 'America/Argentina/Buenos_Aires']) {
        const text = describeCron(cron, { timezone, hour12 });
        expect(text).not.toMatch(/^Custom/);
        expect(parseSchedule(text)).toEqual({ ok: true, cron, timezone });
      }
      // Without a zone (content YAML `every:`): the same cron, no zone.
      expect(parseSchedule(describeCron(cron))).toEqual({ ok: true, cron });
    },
  );
});

describe('next runs across daylight-saving changes (croner, as the scheduler computes them)', () => {
  const next = (cron: string, timezone: string, from: string, n: number) =>
    nextRuns(cron, timezone, new Date(from), n).map((d) => d.toISOString());

  it('a daily 01:30 in London runs once on the spring-forward day (02:30 BST) and once on the fall-back day', () => {
    // 2026-03-29: 01:00 GMT → 02:00 BST, so 01:30 doesn't exist; 2026-10-25: 01:00–02:00 happens twice.
    expect(next('30 1 * * *', 'Europe/London', '2026-03-28T00:00:00Z', 3)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ]);
    expect(next('30 1 * * *', 'Europe/London', '2026-10-24T00:00:00Z', 3)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('weekdays at 07:00 New York keep 07:00 local across the March change', () => {
    expect(
      next(cronOf(parseSchedule('every weekday at 7:00 am')), 'America/New_York', '2026-03-06T00:00:00Z', 3),
    ).toEqual(['2026-03-06T12:00:00.000Z', '2026-03-09T11:00:00.000Z', '2026-03-10T11:00:00.000Z']);
  });

  it('the first Monday and the last Friday of the month land on the right dates', () => {
    expect(
      next(cronOf(parseSchedule('first Monday of the month at 8:30')), 'UTC', '2026-10-17T00:00:00Z', 3),
    ).toEqual(['2026-11-02T08:30:00.000Z', '2026-12-07T08:30:00.000Z', '2027-01-04T08:30:00.000Z']);
    expect(
      next(cronOf(parseSchedule('last Friday of the month at 17:00')), 'UTC', '2026-10-17T00:00:00Z', 2),
    ).toEqual(['2026-10-30T17:00:00.000Z', '2026-11-27T17:00:00.000Z']);
    expect(
      next(cronOf(parseSchedule('last day of the month at 23:00')), 'UTC', '2027-01-15T00:00:00Z', 2),
    ).toEqual(['2027-01-31T23:00:00.000Z', '2027-02-28T23:00:00.000Z']);
  });

  it('every 4 hours counts from local midnight, so the spring-forward day has a 3-hour gap', () => {
    expect(next('0 */4 * * *', 'Europe/London', '2026-03-28T23:30:00Z', 3)).toEqual([
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T03:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
    ]);
  });
});
