import { describeCron as describeShared } from '@adminforge/schemas';
import { Cron } from 'croner';

/**
 * Cron helpers for schedules (R6): next run in the schedule's IANA time zone (croner; DST-aware), and a plain-English
 * description for the UI. Patterns are validated by @adminforge/schemas (`validateCron`) before they get here; English
 * (`every:`, the editor's text box) is turned into cron by `parseSchedule` there too.
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

/** Shortest interval between two runs of a schedule created in the portal ("at most hourly"). */
export const PORTAL_MIN_INTERVAL_MS = 3_600_000;
const FREQUENCY_HORIZON_MS = 8 * 86_400_000;

/**
 * Whether two consecutive runs of `cron` (in `timezone`) come closer than `minIntervalMs`, looking at ~8 days of runs
 * from its first run after `after`. Starting at the first run (not at `after`) means a pattern limited to a later
 * month or day ("* * * 12 *") is judged on the days it actually runs. A pattern that never fires is not too frequent.
 * Throws on an invalid pattern (validate it first).
 */
export function runsTooOften(
  cron: string,
  timezone: string,
  after: Date,
  minIntervalMs = PORTAL_MIN_INTERVAL_MS,
): boolean {
  let prev = nextRun(cron, timezone, after);
  if (!prev) return false;
  const end = prev.getTime() + FREQUENCY_HORIZON_MS;
  // At most one run per interval passes the check, so the loop is bounded by horizon / interval (+ a safety cap).
  for (let i = 0; i < 2_000; i++) {
    const next = nextRun(cron, timezone, prev);
    if (!next || next.getTime() > end) return false;
    if (next.getTime() - prev.getTime() < minIntervalMs) return true;
    prev = next;
  }
  return false;
}

/**
 * Plain-English description naming the schedule's time zone ("Every weekday (Mon–Fri) at 07:00 Europe/London"), from
 * the describer the web app uses too (@adminforge/schemas cadence.ts; 24-hour clock here). Null for shapes it can't
 * describe simply — the UI then shows the expression itself.
 */
export function describeCron(cron: string, timezone?: string): string | null {
  const text = describeShared(cron, timezone ? { timezone } : {});
  return text.startsWith('Custom:') ? null : text;
}
