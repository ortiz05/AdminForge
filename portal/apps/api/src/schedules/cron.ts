import { Cron } from 'croner';

/**
 * Cron helpers for schedules (R6): next run in the schedule's IANA time zone (croner; DST-aware), and a plain-language
 * description for the UI. Patterns are validated by @adminforge/schemas (`validateCron`) before they get here.
 */

const cache = new Map<string, Cron>();

function pattern(cron: string, timezone: string): Cron {
  const key = `${timezone}\u0000${cron}`;
  let c = cache.get(key);
  if (!c) {
    c = new Cron(cron.trim(), { timezone, paused: true, mode: '5-or-6-parts' });
    if (cache.size > 500) cache.clear();
    cache.set(key, c);
  }
  return c;
}

/** The first run strictly after `after`, or null when the pattern never fires again. Throws on an invalid pattern. */
export function nextRun(cron: string, timezone: string, after: Date): Date | null {
  return pattern(cron, timezone).nextRun(after) ?? null;
}

/** The next `n` runs after `after`. */
export function nextRuns(cron: string, timezone: string, after: Date, n: number): Date[] {
  return pattern(cron, timezone).nextRuns(n, after);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_ABBR: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const NICKNAMES: Record<string, string> = {
  '@yearly': 'Every year on 1 January at 00:00',
  '@annually': 'Every year on 1 January at 00:00',
  '@monthly': 'On the 1st of every month at 00:00',
  '@weekly': 'Every Sunday at 00:00',
  '@daily': 'Every day at 00:00',
  '@midnight': 'Every day at 00:00',
  '@hourly': 'Every hour, on the hour',
};

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);
const pad = (n: number) => String(n).padStart(2, '0');

function dayOfWeek(token: string): number | undefined {
  return num(token) ?? DAY_ABBR[token.toUpperCase()];
}

/** "Monday", "weekdays", "Monday and Thursday", "Monday to Wednesday" — or undefined when not a simple list/range. */
function describeDays(field: string): string | undefined {
  if (field === '1-5' || field.toUpperCase() === 'MON-FRI') return 'weekdays';
  if (
    field === '0,6' ||
    field === '6,0' ||
    field.toUpperCase() === 'SAT,SUN' ||
    field.toUpperCase() === 'SUN,SAT'
  )
    return 'Saturday and Sunday';
  const range = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/.exec(field);
  if (range) {
    const a = dayOfWeek(range[1]!);
    const b = dayOfWeek(range[2]!);
    return a !== undefined && b !== undefined ? `${DAY_NAMES[a]} to ${DAY_NAMES[b]}` : undefined;
  }
  const days = field.split(',').map(dayOfWeek);
  if (days.some((d) => d === undefined)) return undefined;
  const names = days.map((d) => DAY_NAMES[d!]!);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/**
 * Plain-language preview of a cron pattern ("Every 15 minutes", "Every Monday at 07:00", "Every 6 hours at minute 20").
 * Returns null for patterns it cannot describe simply (the UI then shows the pattern itself).
 */
export function describeCron(cron: string): string | null {
  const text = cron.trim();
  const nick = NICKNAMES[text.toLowerCase()];
  if (nick) return nick;
  let parts = text.split(/\s+/);
  if (parts.length === 6) {
    if (parts[0] !== '0') return null;
    parts = parts.slice(1);
  }
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const anyDay = (dom === '*' || dom === '?') && (dow === '*' || dow === '?');
  if (mon !== '*') return null;

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (hour === '*' && anyDay) {
    if (min === '*') return 'Every minute';
    if (everyMin) return Number(everyMin[1]) === 1 ? 'Every minute' : `Every ${everyMin[1]} minutes`;
    const m = num(min);
    if (m !== undefined) return m === 0 ? 'Every hour, on the hour' : `Every hour at minute ${pad(m)}`;
    return null;
  }
  const m = num(min);
  if (m === undefined) return null;
  const everyHour = /^\*\/(\d+)$/.exec(hour) ?? /^0\/(\d+)$/.exec(hour);
  if (everyHour && anyDay) return `Every ${everyHour[1]} hours at minute ${pad(m)}`;

  const hours = hour.split(',').map(num);
  if (hours.some((h) => h === undefined)) return null;
  const times = hours.map((h) => `${pad(h!)}:${pad(m)}`).join(', ');
  if (anyDay) return `Every day at ${times}`;
  if (dom === '*' || dom === '?') {
    const days = describeDays(dow);
    if (!days) return null;
    return days === 'weekdays' ? `Weekdays at ${times}` : `Every ${days} at ${times}`;
  }
  if (dow === '*' || dow === '?') {
    if (dom === 'L') return `On the last day of every month at ${times}`;
    const d = num(dom);
    return d !== undefined ? `On the ${ordinal(d)} of every month at ${times}` : null;
  }
  return null;
}
