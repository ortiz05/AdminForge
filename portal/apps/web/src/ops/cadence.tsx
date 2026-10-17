import { useEffect, useEffectEvent, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Checkbox, cn, field, Select, TextField, WarningCircleIcon } from '@adminforge/ui';
import {
  describeCron as describeSentence,
  HOUR_STEPS,
  parseSchedule,
  splitTrailingZone,
  validateCron,
} from '@adminforge/schemas';
import { api, isRecord } from '../lib/api';
import { browserZone, describeCron, prefersHour12, timeZoneList } from './cron';

/**
 * The cadence builder shared by the schedule editor (content YAML) and the report schedule form (Reports): plain
 * choices — or a sentence typed in English — → a cron expression (`cronFor`), and back again for editing
 * (`partsFromCron`). The English grammar and the describer are @adminforge/schemas cadence.ts, the same the API and
 * content YAML (`every:`) use. Each form keeps its own time zone (TimeZoneField) and preview (`useCronPreview`).
 */

export type Cadence =
  | 'minutes'
  | 'hours'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'monthlyWeekday'
  | 'english'
  | 'custom';

export const ALL_CADENCES: readonly Cadence[] = [
  'minutes',
  'hourly',
  'hours',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'monthlyWeekday',
  'english',
  'custom',
];

export const CADENCE_LABEL: Record<Cadence, string> = {
  minutes: 'Every few minutes',
  hourly: 'Every hour',
  hours: 'Every few hours',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  monthly: 'Every month',
  monthlyWeekday: 'Monthly by weekday',
  english: 'Type it in English',
  custom: 'Custom (cron)',
};

const CADENCE_DESCRIPTION: Partial<Record<Cadence, string>> = {
  weekdays: 'Monday to Friday',
  weekly: 'On the days you tick',
  monthly: 'On a date, or the last day',
  monthlyWeekday: 'The first Monday, the last Friday…',
  english: '“first Monday of the month at 8:30”',
};

export const DAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

const NTH_OPTIONS = [
  { value: '1', label: 'First' },
  { value: '2', label: 'Second' },
  { value: '3', label: 'Third' },
  { value: '4', label: 'Fourth' },
  { value: 'L', label: 'Last' },
];

const MONTH_DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) })),
  { value: 'L', label: 'Last day' },
];

function ordinal(n: number): string {
  const s =
    n % 10 === 1 && n !== 11
      ? 'st'
      : n % 10 === 2 && n !== 12
        ? 'nd'
        : n % 10 === 3 && n !== 13
          ? 'rd'
          : 'th';
  return `${n}${s}`;
}

/** The browser's zone (any IANA zone the scheduler accepts), else UTC. */
export function defaultZone(): string {
  return browserZone();
}

/** Time zone choices for a plain select: UTC, the browser's zone, any zone already in use, then every IANA zone. */
export function zoneOptions(...extra: Array<string | undefined>): Array<{ value: string; label: string }> {
  return timeZoneList(...extra).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}

export interface CronParts {
  cadence: Cadence;
  /** Every N minutes (minutes). */
  every: number;
  /** Every N hours (hours). */
  hours: number;
  /** Minutes past the hour (hourly, hours). */
  minute: number;
  /** HH:MM (daily, weekdays, weekly, monthly, monthlyWeekday). */
  time: string;
  /** The weekday of monthlyWeekday ("0"–"6", 0 = Sunday). */
  day: string;
  /** The days ticked for weekly ("0"–"6"). */
  days: string[];
  /** monthly: "1"–"28", or "L" for the last day of the month. */
  dayOfMonth: string;
  /** monthlyWeekday: "1"–"4", or "L" for the last one. */
  nth: string;
  /** The sentence typed in English. */
  english: string;
  custom: string;
}

/** Every Monday at 06:00 — the starting point of a new schedule. */
export const DEFAULT_CRON_PARTS: CronParts = {
  cadence: 'weekly',
  every: 15,
  hours: 4,
  minute: 0,
  time: '06:00',
  day: '1',
  days: ['1'],
  dayOfMonth: '1',
  nth: '1',
  english: '',
  custom: '0 6 * * 1',
};

/** The cron expression for the builder's choices ('' while the English can't be read). */
export function cronFor(p: CronParts): string {
  const [h = '0', m = '0'] = p.time.split(':');
  const hh = String(Number(h));
  const mm = String(Number(m));
  switch (p.cadence) {
    case 'minutes':
      return `*/${p.every} * * * *`;
    case 'hours':
      return `${p.minute} */${p.hours} * * *`;
    case 'hourly':
      return `${p.minute} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly': {
      const days = [...new Set(p.days)].map(Number).sort((a, b) => a - b);
      const list = days.join(',');
      // No day ticked is no schedule yet (cadenceProblem says so), never a quiet Monday.
      return list ? `${mm} ${hh} * * ${list === '1,2,3,4,5' ? '1-5' : list}` : '';
    }
    case 'monthly':
      return `${mm} ${hh} ${p.dayOfMonth} * *`;
    case 'monthlyWeekday':
      return `${mm} ${hh} * * ${p.day}${p.nth === 'L' ? 'L' : `#${p.nth}`}`;
    case 'english': {
      const parsed = parseSchedule(p.english);
      return parsed.ok ? parsed.cron : '';
    }
    default:
      return p.custom.trim();
  }
}

/** The report schedule form's rule (the API refuses faster schedules with `cron_too_frequent`). */
export const HOURLY_ONLY = 'Reports run at most once an hour. Try “every hour” or “every 2 hours”.';

/** More than one run in some hour: the minute field (seconds too, with six fields) isn't a single value. */
export function runsMoreThanHourly(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 5) return false;
  const [seconds, minute] = fields.length === 6 ? fields : ['0', fields[0]!];
  return !/^\d{1,2}$/.test(minute!) || !/^\d{1,2}$/.test(seconds!);
}

/**
 * Why the builder has no usable cron yet, for the field's inline error: English it can't read, a cron expression that
 * isn't valid, no day ticked — and, with `hourlyOnly` (report schedules), anything that runs more than once an hour.
 */
export function cadenceProblem(p: CronParts, opts: { hourlyOnly?: boolean } = {}): string | undefined {
  let cron: string;
  if (p.cadence === 'english') {
    const parsed = parseSchedule(p.english);
    if (!parsed.ok) return parsed.error;
    cron = parsed.cron;
  } else if (p.cadence === 'custom') {
    if (!p.custom.trim()) return 'Enter a cron expression.';
    const problem = validateCron(p.custom);
    if (problem) return problem;
    cron = p.custom;
  } else if (p.cadence === 'weekly' && p.days.length === 0) return 'Tick at least one day.';
  else cron = cronFor(p);
  return opts.hourlyOnly && runsMoreThanHourly(cron) ? HOURLY_ONLY : undefined;
}

/** What the preview says while the field above shows a problem (the problem itself is shown once, on the field). */
export function previewHint(p: CronParts): string {
  if (p.cadence === 'english')
    return p.english.trim()
      ? 'Fix the sentence above to see when it runs.'
      : 'Type when it should run, above.';
  if (p.cadence === 'weekly') return 'Tick at least one day above to see when it runs.';
  return 'Fix the cron expression above to see when it runs.';
}

/** The shape a cadence really has — English or cron read back into the builder's choices — for default names. */
export function effectiveCadence(p: CronParts): Cadence {
  if (p.cadence !== 'english' && p.cadence !== 'custom') return p.cadence;
  const cron = cronFor(p);
  return cron ? partsFromCron(cron).cadence : p.cadence;
}

const NUM = /^\d+$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The builder's choices for an existing expression (editing a schedule). Shapes the builder can't express — or a
 * cadence not offered in this form — come back as `custom` with the expression as typed.
 */
export function partsFromCron(
  expr: string,
  offered: readonly Cadence[] = ALL_CADENCES,
  base: CronParts = DEFAULT_CRON_PARTS,
): CronParts {
  const custom = expr.trim();
  const asCustom: CronParts = { ...base, cadence: 'custom', custom };
  const fields = custom.split(/\s+/);
  if (fields.length !== 5) return asCustom;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  const pick = (p: CronParts): CronParts => (offered.includes(p.cadence) ? p : asCustom);
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(every[1]);
    return [5, 10, 15, 20, 30].includes(n)
      ? pick({ ...base, custom, cadence: 'minutes', every: n })
      : asCustom;
  }
  if (!NUM.test(min) || Number(min) > 59) return asCustom;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return pick({ ...base, custom, cadence: 'hourly', minute: Number(min) });
  const hoursStep = /^\*\/(\d+)$/.exec(hour);
  if (hoursStep && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(hoursStep[1]);
    return (HOUR_STEPS as readonly number[]).includes(n) && n > 1
      ? pick({ ...base, custom, cadence: 'hours', hours: n, minute: Number(min) })
      : asCustom;
  }
  if (!NUM.test(hour) || Number(hour) > 23 || mon !== '*') return asCustom;
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === '*' && dow === '*') return pick({ ...base, custom, cadence: 'daily', time });
  if (dom === '*' && dow === '1-5') return pick({ ...base, custom, cadence: 'weekdays', time });
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(',').map((d) => String(Number(d) % 7)))];
    return pick({ ...base, custom, cadence: 'weekly', time, days, day: days[0]! });
  }
  const nth = /^([0-7])(?:#([1-4])|(L))$/.exec(dow);
  if (dom === '*' && nth)
    return pick({
      ...base,
      custom,
      cadence: 'monthlyWeekday',
      time,
      day: String(Number(nth[1]) % 7),
      nth: nth[2] ?? 'L',
    });
  if (dow === '*' && (dom === 'L' || (NUM.test(dom) && Number(dom) >= 1 && Number(dom) <= 28)))
    return pick({
      ...base,
      custom,
      cadence: 'monthly',
      time,
      dayOfMonth: dom === 'L' ? 'L' : String(Number(dom)),
    });
  return asCustom;
}

/**
 * Repeats / every / at / on / English / cron fields for a CronParts value. Renders the fields only (a fragment), so
 * each form lays them out: stacked in the schedule editor, in a grid in the report schedule form. When English names
 * a time zone ("… Europe/London"), `onTimezone` moves it into the form's time zone field.
 */
export function CadenceFields({
  value,
  onChange,
  cadences = ALL_CADENCES,
  customClassName,
  error,
  timezone = 'UTC',
  onTimezone,
  hourlyOnly,
}: {
  value: CronParts;
  onChange: (next: CronParts) => void;
  cadences?: readonly Cadence[];
  /** Extra classes for the wide fields (cron expression, English), e.g. to span grid columns. */
  customClassName?: string;
  /** A problem with the expression (shown on the cron or English field, else on Repeats). */
  error?: string;
  /** The form's zone, for the English echo. */
  timezone?: string;
  onTimezone?: (zone: string) => void;
  /** Report schedules: anything more often than once an hour is a problem on the field. */
  hourlyOnly?: boolean;
}) {
  const set = (patch: Partial<CronParts>) => onChange({ ...value, ...patch });
  const f = field();
  const typed = value.cadence === 'english' || value.cadence === 'custom';
  const parsed = value.cadence === 'english' ? parseSchedule(value.english) : null;
  const daysErrorId = useId();
  const englishProblem =
    value.cadence === 'english' && value.english.trim() ? cadenceProblem(value, { hourlyOnly }) : undefined;
  const customProblem =
    value.cadence === 'custom' && value.custom.trim() ? cadenceProblem(value, { hourlyOnly }) : undefined;

  // Screen readers hear what the English was understood as (or why not) once typing pauses, not every keystroke.
  const announcement =
    value.cadence !== 'english' || !value.english.trim()
      ? ''
      : (englishProblem ?? (parsed?.ok ? `Understood: ${describeCron(parsed.cron, timezone)}` : ''));
  const announced = useDebounced(announcement, 500);

  // A zone named at the end of the English ("… Europe/London") moves into the form's time zone field.
  // Only when the text's zone changes — choosing another zone in the field afterwards isn't undone.
  const typedZone = parsed?.ok ? parsed.timezone : undefined;
  const applyZone = useEffectEvent((zone: string) => {
    if (zone !== timezone) onTimezone?.(zone);
  });
  useEffect(() => {
    if (typedZone) applyZone(typedZone);
  }, [typedZone]);

  // Choosing another zone in the field takes the zone off the end of the sentence, so the two never disagree.
  const dropTypedZone = useEffectEvent((zone: string) => {
    if (value.cadence !== 'english') return;
    const split = splitTrailingZone(value.english);
    if (split.timezone && split.timezone !== zone) set({ english: split.text });
  });
  useEffect(() => {
    dropTypedZone(timezone);
  }, [timezone]);

  const changeCadence = (cadence: Cadence) => {
    // Switching to English starts from what the builder had, in words; back from English keeps what it understood.
    if (cadence === 'english' && !value.english.trim()) {
      const text = describeSentence(cronFor(value) || value.custom, { hour12: prefersHour12() });
      return set({ cadence, english: text.startsWith('Custom:') ? '' : lower(text) });
    }
    if (value.cadence === 'english' && parsed?.ok && cadence !== 'english')
      return onChange({
        ...partsFromCron(parsed.cron, ALL_CADENCES, value),
        english: value.english,
        cadence,
      });
    set({ cadence });
  };

  return (
    <>
      <Select
        label="Repeats"
        value={value.cadence}
        onValueChange={(v) => changeCadence(v as Cadence)}
        options={cadences.map((c) => ({
          value: c,
          label: CADENCE_LABEL[c],
          ...(CADENCE_DESCRIPTION[c] ? { description: CADENCE_DESCRIPTION[c] } : {}),
        }))}
        error={typed ? undefined : error}
      />
      {value.cadence === 'minutes' && (
        <Select
          label="Every"
          value={String(value.every)}
          onValueChange={(v) => set({ every: Number(v) })}
          options={[5, 10, 15, 20, 30].map((n) => ({ value: String(n), label: `${n} minutes` }))}
        />
      )}
      {value.cadence === 'hours' && (
        <Select
          label="Every"
          value={String(value.hours)}
          onValueChange={(v) => set({ hours: Number(v) })}
          options={HOUR_STEPS.filter((n) => n > 1).map((n) => ({ value: String(n), label: `${n} hours` }))}
          hint="Counted from midnight."
        />
      )}
      {(value.cadence === 'hourly' || value.cadence === 'hours') && (
        <TextField
          label="At minute"
          value={String(value.minute)}
          inputMode="numeric"
          onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
          hint="Minutes past the hour, 0–59."
        />
      )}
      {value.cadence === 'monthlyWeekday' && (
        <>
          <Select
            label="Which"
            value={value.nth}
            onValueChange={(v) => set({ nth: v })}
            options={NTH_OPTIONS}
          />
          <Select label="Day" value={value.day} onValueChange={(v) => set({ day: v })} options={DAYS} />
        </>
      )}
      {value.cadence === 'monthly' && (
        <Select
          label="On"
          value={value.dayOfMonth}
          onValueChange={(v) => set({ dayOfMonth: v })}
          options={MONTH_DAY_OPTIONS}
          hint="1st–28th or the last day, so it runs every month."
        />
      )}
      {['daily', 'weekdays', 'weekly', 'monthly', 'monthlyWeekday'].includes(value.cadence) && (
        <TextField
          label="At"
          type="time"
          value={value.time}
          onChange={(e) => set({ time: e.target.value || '00:00' })}
        />
      )}
      {value.cadence === 'weekly' && (
        <fieldset
          // The whole row: seven days don't fit in one grid column.
          className={cn(f.root(), 'col-span-full')}
          aria-describedby={value.days.length === 0 ? daysErrorId : undefined}
        >
          <legend className={cn(f.label(), 'mb-1.5')}>On</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {DAYS.map((d) => (
              <Checkbox
                key={d.value}
                label={d.label.slice(0, 3)}
                aria-label={d.label}
                checked={value.days.includes(d.value)}
                onCheckedChange={(on) =>
                  set({
                    days: on ? [...value.days, d.value] : value.days.filter((x) => x !== d.value),
                  })
                }
              />
            ))}
          </div>
          {value.days.length === 0 && (
            <p id={daysErrorId} className={f.error()}>
              <WarningCircleIcon size={14} weight="fill" aria-hidden className={f.errorIcon()} />
              Tick at least one day.
            </p>
          )}
        </fieldset>
      )}
      {value.cadence === 'english' && (
        <TextField
          label="When it runs, in English"
          value={value.english}
          onChange={(e) => set({ english: e.target.value })}
          placeholder="every weekday at 7:00 am"
          // The error already carries an example, so the examples hint only shows while nothing is wrong.
          hint={
            englishProblem
              ? undefined
              : parsed?.ok
                ? `Understood: ${describeCron(parsed.cron, timezone)}`
                : 'For example “every Monday at 08:30”, “first Monday of the month at 8:30”, “last day of the month at 23:00” or “every 4 hours”.'
          }
          error={englishProblem ?? (value.english.trim() ? error : undefined)}
          className={customClassName}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      {value.cadence === 'custom' && (
        <TextField
          label="Cron expression"
          value={value.custom}
          onChange={(e) => set({ custom: e.target.value })}
          hint="minute hour day-of-month month day-of-week"
          error={customProblem ?? error}
          className={customClassName}
          inputClassName="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
      )}
      <p role="status" className="sr-only">
        {announced}
      </p>
    </>
  );
}

const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

// ── Live preview (POST /api/schedules/preview) ──────────────────────────────────────────────────────

export interface CronPreview {
  valid: boolean;
  cron: string | null;
  text: string | null;
  timezone: string;
  /** ISO times of the next five runs (computed by the scheduler's own code, DST-aware). */
  next: string[];
  /** Runs closer than an hour apart (schedules created in Reports refuse it). */
  tooFrequent: boolean;
  problem?: string;
}

const CronPreviewResponse = {
  parse(input: unknown): CronPreview {
    if (!isRecord(input) || typeof input.valid !== 'boolean')
      throw new TypeError('Expected a schedule preview');
    return {
      valid: input.valid,
      cron: typeof input.cron === 'string' ? input.cron : null,
      text: typeof input.text === 'string' ? input.text : null,
      timezone: typeof input.timezone === 'string' ? input.timezone : 'UTC',
      next: Array.isArray(input.next) ? input.next.filter((x): x is string => typeof x === 'string') : [],
      tooFrequent: input.tooFrequent === true,
      ...(typeof input.problem === 'string' ? { problem: input.problem } : {}),
    };
  },
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * The next five runs of `cron` in `timezone`, from the API (the scheduler's own, DST-aware computation). Debounced
 * while someone types; keeps the last answer on screen until the next one arrives. Disabled for an empty cron.
 */
export function useCronPreview(cron: string, timezone: string) {
  const key = useDebounced({ cron: cron.trim(), timezone }, 250);
  return useQuery({
    queryKey: ['schedules', 'preview', key.cron, key.timezone] as const,
    queryFn: ({ signal }) =>
      api('/api/schedules/preview', {
        method: 'POST',
        body: { cron: key.cron, timezone: key.timezone },
        schema: CronPreviewResponse,
        signal,
      }),
    enabled: key.cron.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}
