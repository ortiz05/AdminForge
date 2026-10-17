import { describeCron as describeShared, isValidTimeZone } from '@adminforge/schemas';
import { Cron } from 'croner';

/**
 * Cron in plain English ("Every weekday (Mon–Fri) at 7:00 am Europe/London") and the next run times (croner, time-zone
 * aware). The sentence comes from the describer the API uses too (@adminforge/schemas cadence.ts), with the browser's
 * 12- or 24-hour clock; the editors' live preview asks the API for the next runs (POST /api/schedules/preview), lists
 * compute them here.
 */

/** Whether the browser's locale writes times with am/pm (en-US) rather than 24-hour (en-GB). */
export function prefersHour12(): boolean {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h11' || cycle === 'h12';
  } catch {
    return false;
  }
}

/** Plain-English cadence naming the zone, for every shape the editors build; "Custom: <cron>" otherwise. */
export function describeCron(
  expr: string,
  timezone = 'UTC',
  /** `zone: false` leaves the zone out (shown next to it instead). */
  opts: { hour12?: boolean; zone?: boolean } = {},
): string {
  return describeShared(expr, {
    ...(opts.zone === false ? {} : { timezone }),
    hour12: opts.hour12 ?? prefersHour12(),
  });
}

/** Next `count` run times after `from`, in the schedule's time zone; [] when the expression is invalid. */
export function nextRuns(expr: string, timezone: string, count: number, from: Date = new Date()): Date[] {
  try {
    const job = new Cron(expr, { timezone, paused: true, mode: '5-or-6-parts' });
    const runs = job.nextRuns(count, from);
    job.stop();
    return runs;
  } catch {
    return [];
  }
}

/** "Mon 19 Oct, 07:00" (or "7:00 am" where the browser uses a 12-hour clock) in the schedule's own zone. */
export function formatInZone(date: Date | string, timezone: string, opts: { hour12?: boolean } = {}): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hour12 = opts.hour12 ?? prefersHour12();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: hour12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      hourCycle: hour12 ? 'h12' : 'h23',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** UTC, the browser's zone, then every IANA zone the browser knows (A→Z); a fixed list where Intl can't enumerate. */
export function timeZoneList(...extra: Array<string | undefined>): string[] {
  const browser = browserZone();
  let all: string[];
  try {
    all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  if (!all.length) all = [...COMMON_ZONES];
  const modern = (z: string) => {
    const name = MODERN_NAMES[z];
    return name && isValidTimeZone(name) ? name : z;
  };
  return [...new Set(['UTC', browser, ...extra.filter((z): z is string => !!z), ...all.map(modern)])];
}

/**
 * Browsers list some zones by their old ICU names (Asia/Calcutta); engineers look for the current IANA name
 * (Asia/Kolkata), which the scheduler accepts too.
 */
const MODERN_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** The common zones (used where the browser can't list them all). */
export const COMMON_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
] as const;

/** The browser's own zone when the scheduler accepts it, else UTC. */
export function browserZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return isValidTimeZone(zone) ? zone : 'UTC';
}

/** "UTC+01:00" for a zone right now ("" when the browser can't tell). */
export function zoneOffset(timezone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part ? part.replace(/^GMT$/, 'UTC±00:00').replace(/^GMT/, 'UTC') : '';
  } catch {
    return '';
  }
}
