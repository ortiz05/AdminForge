import { Select, TextField } from '@adminforge/ui';

/**
 * The cadence builder shared by the schedule editor (content YAML) and the report schedule form (Reports): plain
 * choices → a cron expression (`cronFor`), and back again for editing (`partsFromCron`). Time zones and the preview
 * stay with each form; the cron helpers that describe and step through an expression are in ./cron.
 */

export type Cadence = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const ALL_CADENCES: readonly Cadence[] = [
  'minutes',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'custom',
];

export const CADENCE_LABEL: Record<Cadence, string> = {
  minutes: 'Every few minutes',
  hourly: 'Every hour',
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  monthly: 'Every month',
  custom: 'Custom (cron)',
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

export const ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
];

/** The browser's zone when it is one of the offered ones, else UTC. */
export function defaultZone(): string {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return ZONES.includes(browser) ? browser : 'UTC';
}

/** Time zone choices: the browser's zone, the common ones, and any zone already in use (an edited schedule). */
export function zoneOptions(...extra: Array<string | undefined>): Array<{ value: string; label: string }> {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return [...new Set([browser, ...ZONES, ...extra.filter((z): z is string => !!z)])].map((z) => ({
    value: z,
    label: z,
  }));
}

export interface CronParts {
  cadence: Cadence;
  every: number;
  minute: number;
  time: string;
  day: string;
  dayOfMonth: number;
  custom: string;
}

/** Every Monday at 06:00 — the starting point of a new schedule. */
export const DEFAULT_CRON_PARTS: CronParts = {
  cadence: 'weekly',
  every: 15,
  minute: 0,
  time: '06:00',
  day: '1',
  dayOfMonth: 1,
  custom: '0 6 * * 1',
};

/** The cron expression for the builder's choices. */
export function cronFor(p: CronParts): string {
  const [h = '0', m = '0'] = p.time.split(':');
  const hh = String(Number(h));
  const mm = String(Number(m));
  switch (p.cadence) {
    case 'minutes':
      return `*/${p.every} * * * *`;
    case 'hourly':
      return `${p.minute} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${p.day}`;
    case 'monthly':
      return `${mm} ${hh} ${p.dayOfMonth} * *`;
    default:
      return p.custom.trim();
  }
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
    return [5, 10, 15, 30].includes(n) ? pick({ ...base, custom, cadence: 'minutes', every: n }) : asCustom;
  }
  if (!NUM.test(min) || Number(min) > 59) return asCustom;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return pick({ ...base, custom, cadence: 'hourly', minute: Number(min) });
  if (!NUM.test(hour) || Number(hour) > 23 || mon !== '*') return asCustom;
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === '*' && dow === '*') return pick({ ...base, custom, cadence: 'daily', time });
  if (dom === '*' && dow === '1-5') return pick({ ...base, custom, cadence: 'weekdays', time });
  if (dom === '*' && /^[0-7]$/.test(dow))
    return pick({ ...base, custom, cadence: 'weekly', time, day: String(Number(dow) % 7) });
  if (NUM.test(dom) && Number(dom) >= 1 && Number(dom) <= 28 && dow === '*')
    return pick({ ...base, custom, cadence: 'monthly', time, dayOfMonth: Number(dom) });
  return asCustom;
}

/**
 * Repeats / every / at / on / cron fields for a CronParts value. Renders the fields only (a fragment), so each form
 * lays them out: stacked in the schedule editor, in a row in the report schedule form.
 */
export function CadenceFields({
  value,
  onChange,
  cadences = ALL_CADENCES,
  customClassName,
  error,
}: {
  value: CronParts;
  onChange: (next: CronParts) => void;
  cadences?: readonly Cadence[];
  /** Extra classes for the cron expression field (e.g. to span two grid columns). */
  customClassName?: string;
  /** A problem with the expression (shown on the cron field for custom, else on Repeats). */
  error?: string;
}) {
  const set = (patch: Partial<CronParts>) => onChange({ ...value, ...patch });
  return (
    <>
      <Select
        label="Repeats"
        value={value.cadence}
        onValueChange={(v) => set({ cadence: v as Cadence })}
        options={cadences.map((c) => ({ value: c, label: CADENCE_LABEL[c] }))}
        error={value.cadence === 'custom' ? undefined : error}
      />
      {value.cadence === 'minutes' && (
        <Select
          label="Every"
          value={String(value.every)}
          onValueChange={(v) => set({ every: Number(v) })}
          options={[5, 10, 15, 30].map((n) => ({ value: String(n), label: `${n} minutes` }))}
        />
      )}
      {value.cadence === 'hourly' && (
        <TextField
          label="At minute"
          value={String(value.minute)}
          inputMode="numeric"
          onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
        />
      )}
      {['daily', 'weekdays', 'weekly', 'monthly'].includes(value.cadence) && (
        <TextField
          label="At"
          type="time"
          value={value.time}
          onChange={(e) => set({ time: e.target.value || '00:00' })}
        />
      )}
      {value.cadence === 'weekly' && (
        <Select label="On" value={value.day} onValueChange={(v) => set({ day: v })} options={DAYS} />
      )}
      {value.cadence === 'monthly' && (
        <TextField
          label="On day"
          value={String(value.dayOfMonth)}
          inputMode="numeric"
          onChange={(e) => set({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
          hint="1–28, so it runs every month."
        />
      )}
      {value.cadence === 'custom' && (
        <TextField
          label="Cron expression"
          value={value.custom}
          onChange={(e) => set({ custom: e.target.value })}
          hint="minute hour day-of-month month day-of-week"
          error={error}
          className={customClassName}
          inputClassName="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
      )}
    </>
  );
}
