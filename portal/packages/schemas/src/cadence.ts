/**
 * Schedule times in plain English — one module for every place that shows or takes one: the API's `cronText` and
 * schedule preview, the schedule list and editors in the web app, and content YAML's `every:`.
 *
 *   describeCron("30 8 * * 1#1", { timezone: "Europe/London" }) → "On the first Monday of every month at 08:30 Europe/London"
 *   parseSchedule("first Monday of the month at 8:30 am")      → { ok: true, cron: "30 8 * * 1#1" }
 *
 * Shapes covered (the editors build exactly these, and `parseSchedule(describeCron(x)).cron === x` for each):
 *
 *   * * * * *         every minute               M H * * 1-5     every weekday (Mon–Fri)
 *   *\/N * * * *      every N minutes            M H * * D,D…    chosen days of the week (0 or 7 = Sunday)
 *   M * * * *         every hour at :MM          M H D * *       monthly on day D
 *   M *\/N * * *      every N hours at :MM       M H * * D#n     the Nth weekday of the month (1#1 = first Monday)
 *   M H[,H…] * * *    every day                  M H * * DL      the last weekday of the month (5L = last Friday)
 *                                                M H L * *       the last day of the month
 *
 * Anything else is described as "Custom: <cron>". Day of month and day of week are never combined: cron (and croner)
 * run when EITHER field matches, so "the first Monday" must be `1#1`, never `1-7 … 1`; the grammar refuses the
 * combination. Every N hours counts from local midnight (croner), so the gap around a daylight-saving change is an
 * hour shorter or longer.
 *
 * Pure and dependency-free — next-run times are computed where croner runs (apps/api schedules/cron.ts, web ops/cron.ts).
 */

// ── Validation (re-exported by schedule.ts) ────────────────────────────────────────────────────────────

const CRON_NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface CronField {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
  dom?: boolean;
  dow?: boolean;
}
const SECOND: CronField = { name: 'second', min: 0, max: 59 };
const FIELDS: CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31, dom: true },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0, dow: true },
];

function cronValue(token: string, f: CronField): number | undefined {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= f.min && n <= f.max ? n : undefined;
  }
  const i = f.names?.indexOf(token.toUpperCase()) ?? -1;
  return i >= 0 ? i + (f.nameBase ?? 0) : undefined;
}

function checkCronField(text: string, f: CronField): string | undefined {
  for (const part of text.split(',')) {
    if (part === '') return `empty list item in ${f.name}`;
    if (part === '?' && (f.dom || f.dow)) continue;
    if (f.dom && /^(L|L-\d{1,2}|\d{1,2}W|LW)$/.test(part)) continue;
    if (f.dow && /^[0-7A-Za-z]{1,3}(L|#[1-5])$/.test(part)) {
      if (cronValue(part.replace(/(L|#[1-5])$/, ''), f) === undefined) return `invalid ${f.name} "${part}"`;
      continue;
    }
    const [range, step, extra] = part.split('/');
    if (extra !== undefined) return `invalid step in ${f.name} "${part}"`;
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1 && Number(step) <= f.max))
      return `invalid step in ${f.name} "${part}"`;
    if (range === '*') continue;
    const [a, b, more] = (range ?? '').split('-');
    if (more !== undefined) return `invalid range in ${f.name} "${part}"`;
    const lo = cronValue(a ?? '', f);
    if (lo === undefined) return `${f.name} "${a}" is out of range ${f.min}-${f.max}`;
    if (b !== undefined) {
      const hi = cronValue(b, f);
      if (hi === undefined) return `${f.name} "${b}" is out of range ${f.min}-${f.max}`;
      if (hi < lo) return `${f.name} range "${range}" is reversed`;
    }
  }
  return undefined;
}

/** Validates a 5-field (`m h dom mon dow`) or 6-field (seconds first) cron expression, or a nickname like `@daily`. Returns an error message or undefined. */
export function validateCron(expr: string): string | undefined {
  const text = expr.trim();
  if (Object.hasOwn(CRON_NICKNAMES, text.toLowerCase())) return undefined;
  const parts = text.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return `Expected 5 or 6 cron fields, got ${parts.length}`;
  const fields = parts.length === 6 ? [SECOND, ...FIELDS] : FIELDS;
  for (let i = 0; i < parts.length; i++) {
    const err = checkCronField(parts[i]!, fields[i]!);
    if (err) return `Invalid cron: ${err}`;
  }
  return undefined;
}

/** True for IANA zone names the runtime knows (and `UTC`). */
export function isValidTimeZone(tz: string): boolean {
  if (!/^(UTC|GMT|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Describing ─────────────────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
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
const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

/** Steps that divide the hour / the day evenly — the only ones the editors and the grammar offer. */
export const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export interface DescribeOptions {
  /** IANA zone named at the end ("… at 07:00 Europe/London"); left out of the sentence when not given. */
  timezone?: string;
  /** "7:00 am" instead of "07:00" (the web follows the browser's locale; the API uses 24-hour time). */
  hour12?: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isNum = (s: string) => /^\d+$/.test(s);
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** "UTC", "Europe/London", "America/New York" (underscores read as spaces). */
export function zoneLabel(tz: string): string {
  return tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT' ? 'UTC' : tz.replace(/_/g, ' ');
}

/** "07:00", or "7:00 am" / "12:00 pm" (noon) / "12:00 am" (midnight) with `hour12`. */
export function clockText(hour: number, minute: number, hour12 = false): string {
  if (!hour12) return `${pad(hour)}:${pad(minute)}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${pad(minute)} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "Monday", "Monday and Friday", "Monday, Wednesday and Friday" — in week order, Monday first. */
function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Days of the week a plain list/range field names (0 = Sunday), sorted; null for steps, # or L. */
function dowSet(field: string): number[] | null {
  if (field === '*' || field === '?') return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  const value = (x: string) => (isNum(x) ? Number(x) : DAYS.indexOf(x.toUpperCase()));
  for (const part of field.split(',')) {
    const [a = '', b, extra] = part.split('-');
    if (extra !== undefined) return null;
    const lo = value(a);
    if (lo < 0 || lo > 7) return null;
    if (b === undefined) {
      out.add(lo % 7);
      continue;
    }
    const hi = value(b);
    if (hi < 0 || hi > 7 || hi < lo) return null;
    for (let d = lo; d <= hi; d++) out.add(d % 7);
  }
  return [...out].sort((x, y) => x - y);
}

const weekOrder = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/** The days part of a sentence for a plain day-of-week set: "Every weekday (Mon–Fri)", "Every Monday and Friday". */
function daysPhrase(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Every weekday (Mon–Fri)';
  return `Every ${joinWords(weekOrder(days).map((d) => DAY_NAMES[d]!))}`;
}

/**
 * Plain-English sentence for a cron expression, naming the time zone when one is given: "Every weekday (Mon–Fri) at
 * 07:00 UTC", "Every 15 minutes (UTC)", "On the last Friday of every month at 5:00 pm Europe/London". Shapes outside
 * the covered set come back as "Custom: <cron>".
 */
export function describeCron(expr: string, opts: DescribeOptions = {}): string {
  const original = expr.trim();
  const custom = `Custom: ${original}`;
  const zone = opts.timezone ? zoneLabel(opts.timezone) : undefined;
  const after = zone ? ` ${zone}` : '';
  const inZone = zone ? ` (${zone})` : '';
  const text = CRON_NICKNAMES[original.toLowerCase()] ?? original;
  let parts = text.split(/\s+/);
  if (parts.length === 6) {
    if (parts[0] !== '0') return custom;
    parts = parts.slice(1);
  }
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const anyDom = dom === '*' || dom === '?';
  const anyDow = dow === '*' || dow === '?';
  const anyDay = anyDom && anyDow && mon === '*';

  // Interval shapes: minutes and hours.
  const step = (f: string) => /^(?:\*|0)\/(\d+)$/.exec(f)?.[1];
  if (anyDay && hour === '*') {
    const n = min === '*' ? 1 : step(min) !== undefined ? Number(step(min)) : undefined;
    if (n !== undefined) return n === 1 ? `Every minute${inZone}` : `Every ${n} minutes${inZone}`;
    if (isNum(min) && Number(min) <= 59)
      return Number(min) === 0
        ? `Every hour, on the hour${inZone}`
        : `Every hour at :${pad(Number(min))}${inZone}`;
    return custom;
  }
  if (!isNum(min) || Number(min) > 59) return custom;
  const m = Number(min);
  if (anyDay && step(hour) !== undefined) {
    const n = Number(step(hour));
    const every = n === 1 ? 'Every hour' : `Every ${n} hours`;
    return m === 0 ? `${every}, on the hour${inZone}` : `${every} at :${pad(m)}${inZone}`;
  }

  // Time-of-day shapes.
  if (!/^\d{1,2}(,\d{1,2})*$/.test(hour)) return custom;
  const hours = [...new Set(hour.split(',').map(Number))].sort((a, b) => a - b);
  if (hours.some((h) => h > 23)) return custom;
  const at = `at ${joinWords(hours.map((h) => clockText(h, m, opts.hour12)))}${after}`;

  if (mon !== '*') {
    if (isNum(dom) && isNum(mon) && anyDow && Number(mon) >= 1 && Number(mon) <= 12)
      return `Every year on ${Number(dom)} ${MONTH_NAMES[Number(mon) - 1]} ${at}`;
    return custom;
  }
  if (anyDom) {
    const nth = /^([0-7]|[A-Za-z]{3})(?:#([1-5])|(L))$/.exec(dow);
    if (nth) {
      const d = dowSet(nth[1]!)?.[0];
      if (d === undefined) return custom;
      const which = nth[2] ? ORDINAL_WORDS[Number(nth[2])] : 'last';
      return `On the ${which} ${DAY_NAMES[d]} of every month ${at}`;
    }
    const days = dowSet(dow);
    return days ? `${daysPhrase(days)} ${at}` : custom;
  }
  if (!anyDow) return custom;
  if (dom === 'L') return `On the last day of every month ${at}`;
  if (isNum(dom) && Number(dom) >= 1 && Number(dom) <= 31)
    return `On the ${ordinal(Number(dom))} of every month ${at}`;
  return custom;
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────

export type ParsedSchedule =
  | {
      ok: true;
      /** 5-field cron. */
      cron: string;
      /** A time zone named in the text ("… at 07:00 Europe/London"), canonical IANA spelling. */
      timezone?: string;
    }
  | { ok: false; error: string };

const EXAMPLE = 'Try something like “every weekday at 7:00 am” or “first Monday of the month at 8:30”.';
const fail = (error: string): ParsedSchedule => ({ ok: false, error });

const DAY_WORD =
  '(sun(?:day)?s?|mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?)';
const dayIndex = (word: string) => DAYS.indexOf(word.slice(0, 3).toUpperCase());
const MONTH_WORD =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = (word: string) => MONTHS.indexOf(word.slice(0, 3).toUpperCase()) + 1;
const NTH: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  last: 0,
};
/** Words that carry no meaning of their own once the phrases around them are understood. */
const FILLER = new Set([
  'every',
  'each',
  'on',
  'the',
  'at',
  'and',
  ',',
  '&',
  'of',
  'in',
  'a',
  'run',
  'runs',
  'it',
  'please',
  'o’clock',
  "o'clock",
  'oclock',
]);

/** Canonical spelling of an IANA zone typed in any case ("europe/london" → "Europe/London"); undefined if unknown. */
function canonicalZone(candidate: string): string | undefined {
  const name = candidate.replace(/\s+/g, '_');
  if (/^(utc|gmt|etc\/utc)$/i.test(name)) return 'UTC';
  const resolve = (z: string) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  };
  const resolved = resolve(name);
  if (!resolved) return undefined;
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
  const listed = supported?.find((z) => z.toLowerCase() === name.toLowerCase());
  if (listed) return listed;
  // Not in the runtime's list (an alias such as America/Argentina/Buenos_Aires): keep the name as typed, in IANA case.
  const titled = name.replace(/(^|[/_-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
  return isValidTimeZone(titled) && resolve(titled) === resolved ? titled : resolved;
}

/** Five or six cron-looking fields ("15 6 * * 1", "*\/5 * * * *") or a nickname ("@daily") — not English. */
function looksLikeCron(text: string): boolean {
  if (/^@\w+$/.test(text)) return true;
  const fields = text.split(/\s+/);
  return (
    (fields.length === 5 || fields.length === 6) && fields.slice(0, 2).every((f) => /^[\d*/,?-]+$/.test(f))
  );
}

/**
 * Splits a time zone off the end of a phrase — "… 07:00 Europe/London", "… (UTC)", "… America/New York" (the
 * describer's own label) — keeping the rest as typed. `unknownZone` is a zone-looking ending nobody knows
 * ("Mars/Olympus"), as typed.
 */
export function splitTrailingZone(input: string): { text: string; timezone?: string; unknownZone?: string } {
  const text = input.trim().replace(/\.$/, '');
  const m = /\(?\s*(utc|gmt|[a-z]+(?:\/[a-z0-9_+-]+)+(?:\s[a-z][a-z0-9_+-]*){0,3})\s*\)?\s*$/i.exec(text);
  if (!m) return { text };
  const words = m[1]!.split(' ');
  for (let n = words.length; n >= 1; n--) {
    const zone = canonicalZone(words.slice(0, n).join(' '));
    if (zone) return { text: `${text.slice(0, m.index)} ${words.slice(n).join(' ')}`.trim(), timezone: zone };
  }
  return /\//.test(m[1]!) ? { text, unknownZone: m[1]! } : { text };
}

/**
 * Turns a short English phrase into cron (a small, closed grammar — never a guess): "every weekday at 7:00 am",
 * "every Monday at 08:30", "mon, wed and fri at 18:00", "first Monday of the month at 8:30", "last Friday of the month
 * at 17:00", "last day of the month at 23:00", "on the 15th of every month at 06:00", "every 4 hours", "every hour at
 * :15", "every 15 minutes", "daily at noon", "every day at midnight", "at 07:00 and 19:00". A trailing time zone
 * ("… Europe/London", "(UTC)") is returned separately; a typed cron expression is accepted as it is. Anything it can't
 * read is refused, naming the word it didn't understand.
 */
export function parseSchedule(input: string): ParsedSchedule {
  const raw = input.trim();
  if (!raw) return fail(`Type when it should run. ${EXAMPLE}`);
  // A cron expression typed into the box is taken as it is — or refused with what's wrong with it.
  if (looksLikeCron(raw)) {
    const problem = validateCron(raw);
    return problem
      ? fail(problem)
      : { ok: true, cron: CRON_NICKNAMES[raw.toLowerCase()] ?? raw.replace(/\s+/g, ' ') };
  }
  const zoned = splitTrailingZone(raw);
  if (zoned.unknownZone)
    return fail(`“${zoned.unknownZone}” isn’t a time zone AdminForge knows. Choose the zone separately.`);
  const timezone = zoned.timezone;

  let s = ` ${zoned.text
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\ba\.m\.?/g, 'am')
    .replace(/\bp\.m\.?/g, 'pm')
    .replace(/,/g, ' , ')
    .replace(/\.(\s|$)/g, '$1')
    .replace(/\s+/g, ' ')} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m;
  };

  // Intervals.
  let minuteStep: number | undefined;
  let hourStep: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = take(/\bevery\s+(\d+)\s*(?:minutes?|mins?)\b/))) minuteStep = Number(m[1]);
  else if (take(/\bevery\s+minute\b/)) minuteStep = 1;
  else if (take(/\bevery\s+half\s+(?:an\s+)?hour\b/)) minuteStep = 30;
  else if (take(/\bevery\s+quarter\s+(?:of\s+an\s+)?hour\b/)) minuteStep = 15;
  if ((m = take(/\bevery\s+(\d+)\s*(?:hours?|hrs?)\b/))) hourStep = Number(m[1]);
  else if (take(/\b(?:every\s+hour|each\s+hour|hourly)\b/)) hourStep = 1;

  // The minute past the hour, for hourly shapes: "at :15", ":15", "15 past", "on the hour".
  let hourMinute: number | undefined;
  if (take(/\s,?\s*on\s+the\s+hour\b/)) hourMinute = 0;
  else if ((m = take(/\bat\s+:(\d{2})\b|(?<=\s):(\d{2})\b/))) hourMinute = Number(m[1] ?? m[2]);
  else if ((m = take(/\b(?:at\s+)?(\d{1,2})\s+(?:minutes?\s+)?past(?:\s+the\s+hour)?\b/)))
    hourMinute = Number(m[1]);

  // Times of day.
  const times: Array<{ h: number; m: number }> = [];
  for (;;) {
    if ((m = take(/\b(?:at\s+)?(noon|midday|midnight)\b/))) {
      times.push({ h: m[1] === 'midnight' ? 0 : 12, m: 0 });
      continue;
    }
    if ((m = take(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))) {
      const h = Number(m[1]);
      if (h < 1 || h > 12) return fail(`“${m[0].trim()}” isn’t a time: with am or pm the hour is 1 to 12.`);
      times.push({ h: (h % 12) + (m[3] === 'pm' ? 12 : 0), m: Number(m[2] ?? 0) });
      continue;
    }
    if ((m = take(/\b(?:at\s+)?(\d{1,2})[:.](\d{2})\b/))) {
      times.push({ h: Number(m[1]), m: Number(m[2]) });
      continue;
    }
    if ((m = take(/\bat\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th)\b)/))) {
      times.push({ h: Number(m[1]), m: 0 });
      continue;
    }
    break;
  }
  const badTime = times.find((t) => t.h > 23 || t.m > 59);
  if (badTime) return fail(`${badTime.h}:${pad(badTime.m)} isn’t a time of day.`);

  // Once a year: "every year on 1 January", "yearly on March 15th".
  let yearly: { day: number; month: number } | undefined;
  if (take(/\b(?:every\s+year|each\s+year|yearly|annually)\b/)) {
    if ((m = take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}\\b`))))
      yearly = { day: Number(m[1]), month: monthIndex(m[2]!) };
    else if ((m = take(new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`))))
      yearly = { day: Number(m[2]), month: monthIndex(m[1]!) };
    else return fail('Which day of the year? For example “every year on 1 January at 09:00”.');
    if (yearly.day < 1 || yearly.day > 31)
      return fail(`The ${ordinal(yearly.day)} isn’t a day of the month.`);
  }

  // Days of the month.
  const monthly = Boolean(
    take(
      /\b(?:of\s+(?:the|every|each|a)\s+month|in\s+(?:the|every|each)\s+month|every\s+month|each\s+month|a\s+month|per\s+month|monthly)\b/,
    ),
  );
  let dom: string | undefined;
  let nth: { n: number; day: number } | undefined;
  if (take(/\blast\s+day\b/)) dom = 'L';
  else if (take(/\bfirst\s+day\b/)) dom = '1';
  if (
    (m = take(new RegExp(`\\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\\s+${DAY_WORD}\\b`)))
  )
    nth = { n: NTH[m[1]!]!, day: dayIndex(m[2]!) };
  if ((m = take(/\b(?:day\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)(?:\s+day)?)\b/))) {
    const d = Number(m[1] ?? m[2]);
    if (d < 1 || d > 31) return fail(`The ${ordinal(d)} isn’t a day of the month.`);
    if (dom) return fail('Choose one day of the month.');
    dom = String(d);
  }

  // Days of the week.
  const days = new Set<number>();
  let daily = false;
  if (take(/\b(?:every\s+day|each\s+day|every\s+night|daily|nightly)\b/)) daily = true;
  if (take(/\b(?:week\s?days?|working\s+days?|business\s+days?|work\s?days?)(?:\s*\(\s*mon\s*-\s*fri\s*\))?/))
    for (const d of [1, 2, 3, 4, 5]) days.add(d);
  if (take(/\b(?:weekend\s+days?|weekends?)\b/)) for (const d of [0, 6]) days.add(d);
  while (
    (m = take(
      new RegExp(`\\b${DAY_WORD}\\s*(?:-|\\bto\\b|\\bthrough\\b|\\bthru\\b|\\buntil\\b)\\s*${DAY_WORD}\\b`),
    ))
  ) {
    const from = dayIndex(m[1]!);
    const to = dayIndex(m[2]!);
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  while ((m = take(new RegExp(`\\b${DAY_WORD}\\b`)))) days.add(dayIndex(m[1]!));

  // Anything left must be filler.
  const unknown = s
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER.has(w));
  if (unknown.length) return fail(`Didn’t understand “${unknown.slice(0, 3).join(' ')}”. ${EXAMPLE}`);

  const withZone = (cron: string): ParsedSchedule => ({ ok: true, cron, ...(timezone ? { timezone } : {}) });
  const hasDays =
    days.size > 0 || daily || dom !== undefined || nth !== undefined || monthly || yearly !== undefined;

  if (minuteStep !== undefined) {
    if (hourStep !== undefined || times.length || hourMinute !== undefined || hasDays)
      return fail('“Every few minutes” runs all day, every day; it can’t be combined with days or times.');
    if (!(MINUTE_STEPS as readonly number[]).includes(minuteStep))
      return fail(`Every ${minuteStep} minutes doesn’t divide the hour evenly; choose 5, 10, 15, 20 or 30.`);
    return withZone(minuteStep === 1 ? '* * * * *' : `*/${minuteStep} * * * *`);
  }
  if (hourStep !== undefined) {
    if (hasDays) return fail('“Every few hours” runs every day; it can’t be combined with days.');
    if (times.length)
      return fail(
        `Every ${hourStep === 1 ? 'hour' : `${hourStep} hours`} counts from midnight; to set the minute say “at :15”.`,
      );
    if (!(HOUR_STEPS as readonly number[]).includes(hourStep))
      return fail(`Every ${hourStep} hours doesn’t divide the day evenly; choose 2, 3, 4, 6, 8 or 12.`);
    const mm = hourMinute ?? 0;
    if (mm > 59) return fail(`:${mm} isn’t a minute past the hour.`);
    return withZone(hourStep === 1 ? `${mm} * * * *` : `${mm} */${hourStep} * * *`);
  }
  if (hourMinute !== undefined)
    return fail('“:MM past the hour” goes with “every hour” or “every few hours”.');
  if (!times.length) return fail(`Add a time, for example “at 7:00 am”. ${EXAMPLE}`);
  const minutes = new Set(times.map((t) => t.m));
  if (minutes.size > 1)
    return fail(
      'All the times need the same minutes past the hour (cron can’t mix 07:00 and 19:30); make two schedules.',
    );
  const mm = times[0]!.m;
  const hh = [...new Set(times.map((t) => t.h))].sort((a, b) => a - b).join(',');

  const kinds = [days.size > 0, dom !== undefined, nth !== undefined, yearly !== undefined].filter(
    Boolean,
  ).length;
  if (kinds > 1)
    return fail(
      'Choose days of the week or a day of the month, not both — cron runs when either matches. For the first Monday say “first Monday of the month”.',
    );
  if (yearly) return withZone(`${mm} ${hh} ${yearly.day} ${yearly.month} *`);
  // "last Friday at 17:00" and "the 15th at 06:00" can only mean once a month, with or without "of the month".
  if (nth) return withZone(`${mm} ${hh} * * ${nth.day}${nth.n ? `#${nth.n}` : 'L'}`);
  if (dom !== undefined) return withZone(`${mm} ${hh} ${dom} * *`);
  if (monthly)
    return fail(
      'Which day of the month? For example “on the 1st of every month” or “first Monday of the month”.',
    );
  if (days.size === 0 || days.size === 7) return withZone(`${mm} ${hh} * * *`);
  const list = [...days].sort((a, b) => a - b);
  return withZone(`${mm} ${hh} * * ${list.join() === '1,2,3,4,5' ? '1-5' : list.join(',')}`);
}
