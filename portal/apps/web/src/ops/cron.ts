import { Cron } from 'croner';

/**
 * Cron in plain words ("Every Monday at 07:00 UTC") and the next run times (croner, time-zone aware). The scheduler
 * sends its own `cronText`; this is the fallback and the preview for anything typed in the portal.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const NICK: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const pad = (n: number) => String(n).padStart(2, '0');
const isNum = (s: string) => /^\d+$/.test(s);

function dayList(field: string): number[] | null {
  const out = new Set<number>();
  const value = (x: string) => (isNum(x) ? Number(x) : DOW_NAMES[x.toUpperCase()]);
  for (const part of field.split(',')) {
    const [a = '', b, extra] = part.split('-');
    if (extra !== undefined) return null;
    const lo = value(a);
    if (lo === undefined || lo > 7) return null;
    if (b === undefined) {
      out.add(lo % 7);
      continue;
    }
    const hi = value(b);
    if (hi === undefined || hi > 7 || hi < lo) return null;
    for (let d = lo; d <= hi; d++) out.add(d % 7);
  }
  return [...out].sort((x, y) => x - y);
}

function joinWords(words: string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function zoneLabel(tz: string): string {
  return tz === 'UTC' || tz === 'Etc/UTC' ? 'UTC' : tz.replace(/_/g, ' ');
}

/** Plain-language cadence for common shapes; "Custom: <cron>" otherwise. */
export function describeCron(expr: string, timezone = 'UTC'): string {
  let text = expr.trim();
  text = NICK[text.toLowerCase()] ?? text;
  let parts = text.split(/\s+/);
  if (parts.length === 6) {
    if (parts[0] !== '0') return `Custom: ${expr}`;
    parts = parts.slice(1);
  }
  if (parts.length !== 5) return `Custom: ${expr}`;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const tz = zoneLabel(timezone);

  const every = /^\*\/(\d+)$/;
  if (every.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(every.exec(min)![1]);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return Number(min) === 0 ? 'Every hour, on the hour' : `Every hour at ${pad(Number(min))} past`;
  if (isNum(min) && every.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(every.exec(hour)![1]);
    return Number(min) === 0
      ? `Every ${n} hours, on the hour`
      : `Every ${n} hours at ${pad(Number(min))} past`;
  }
  if (!isNum(min) || !/^\d+(,\d+)*$/.test(hour)) return `Custom: ${expr}`;
  const at = hour
    .split(',')
    .map((h) => `${pad(Number(h))}:${pad(Number(min))}`)
    .join(', ');
  const time = `at ${at} ${tz}`;

  if (dom === '*' && mon === '*' && (dow === '*' || dow === '?')) return `Every day ${time}`;
  if (dom === '*' || dom === '?') {
    if (mon !== '*') return `Custom: ${expr}`;
    const days = dayList(dow);
    if (!days) return `Custom: ${expr}`;
    if (days.join() === '1,2,3,4,5') return `Every weekday (Mon–Fri) ${time}`;
    if (days.join() === '0,6') return `Every weekend day ${time}`;
    if (days.length === 1) return `Every ${DAY_NAMES[days[0]!]} ${time}`;
    return `Every ${joinWords(days.map((d) => DAY_SHORT[d]!))} ${time}`;
  }
  if (isNum(dom) && (dow === '*' || dow === '?')) {
    const d = Number(dom);
    const suffix =
      d % 10 === 1 && d !== 11
        ? 'st'
        : d % 10 === 2 && d !== 12
          ? 'nd'
          : d % 10 === 3 && d !== 13
            ? 'rd'
            : 'th';
    if (mon === '*') return `On the ${d}${suffix} of every month ${time}`;
    if (isNum(mon)) return `Every year on ${d} ${MONTHS[Number(mon) - 1] ?? mon} ${time}`;
  }
  if (dom === 'L' && mon === '*' && (dow === '*' || dow === '?'))
    return `On the last day of every month ${time}`;
  return `Custom: ${expr}`;
}

/** Next `count` run times after `from`, in the schedule's time zone; [] when the expression is invalid. */
export function nextRuns(expr: string, timezone: string, count: number, from: Date = new Date()): Date[] {
  try {
    const job = new Cron(expr, { timezone, paused: true });
    const runs = job.nextRuns(count, from);
    job.stop();
    return runs;
  } catch {
    return [];
  }
}

/** "Mon 19 Oct, 07:00" in the schedule's own zone. */
export function formatInZone(date: Date | string, timezone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}
