import { mask } from './mask';

/**
 * Comparison and reporting for scripts/check-accuracy.ts — "does AdminForge show what is really there?". Pure: no I/O.
 *
 * A check compares what a datasource returned (as the portal runs it) with what is known in advance (the Phase F
 * fixture catalogue) and/or an independent Microsoft Graph read (a different code path: no AdminForge transform).
 * Each check ends in one `Outcome`:
 *   - `match`         every compared value agrees;
 *   - `mismatch`      a value differs and nothing explains it — the script exits 1;
 *   - `documented`    it differs for a documented Microsoft reason (eventual consistency right after provisioning,
 *                     a report Microsoft refreshes every few hours, data that can't be backdated);
 *   - `unknowable`    the validation user can't read it, the definition isn't published, or nothing is known.
 * Output is masked (lib/mask.ts: GUIDs, addresses/UPNs, tenant hosts); synthetic AF-Test display names are shown.
 * Tested in tests/unit/live/accuracy.test.ts.
 */
export type Status = 'match' | 'mismatch' | 'documented' | 'unknowable';

export interface Outcome {
  /** `<definition id>#<datasource>` (or the definition id alone). */
  page: string;
  /** What was compared, in a few words. */
  check: string;
  status: Status;
  /** One line per difference or note (masked when printed). */
  details: string[];
}

/** One difference: what was expected (and where it came from) versus what AdminForge showed. */
export type Difference = string;

/** The rows of a datasource result: `rows`, `value`, or the array itself. */
export function rowsOf(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['rows', 'value'])
      if (Array.isArray(d[key])) return d[key] as Array<Record<string, unknown>>;
  }
  return [];
}

/** A row's display name: the first of displayName, name, app, userDisplayName, principalName. */
export function nameOf(row: Record<string, unknown>): string | undefined {
  for (const key of ['displayName', 'name', 'app', 'userDisplayName', 'principalName'])
    if (typeof row[key] === 'string') return row[key] as string;
  return undefined;
}

/** The AF-Test (or AF-Audit) names among `names`, sorted — the fixtures' slice of a tenant-wide list. */
export const fixtureNames = (names: Iterable<string | undefined>, prefix = /^AF[- ](Test|Audit)/): string[] =>
  [...new Set([...names].filter((n): n is string => typeof n === 'string' && prefix.test(n)))].sort();

/** Differences between two sets of names: what's missing from `actual` and what it has extra. */
export function compareSets(
  what: string,
  expected: Iterable<string>,
  actual: Iterable<string>,
): Difference[] {
  const e = new Set(expected);
  const a = new Set(actual);
  const missing = [...e].filter((x) => !a.has(x)).sort();
  const extra = [...a].filter((x) => !e.has(x)).sort();
  const out: Difference[] = [];
  if (missing.length) out.push(`${what}: missing ${missing.join(', ')}`);
  if (extra.length) out.push(`${what}: unexpected ${extra.join(', ')}`);
  return out;
}

/** A difference when `actual` isn't `expected` (deep equality on plain values; numbers compared exactly). */
export function compareValue(what: string, expected: unknown, actual: unknown): Difference[] {
  return same(expected, actual)
    ? []
    : [`${what}: expected ${show(expected)}, AdminForge shows ${show(actual)}`];
}

/** A difference when `actual` isn't between `min` and `max` (inclusive). */
export function compareRange(what: string, actual: unknown, min: number, max: number): Difference[] {
  return typeof actual === 'number' && actual >= min && actual <= max
    ? []
    : [`${what}: expected ${min}–${max}, AdminForge shows ${show(actual)}`];
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return (
      same(ka, kb) &&
      ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/** A value for a report line: strings quoted, objects as compact JSON, masked and cut to 80 characters. */
export function show(v: unknown): string {
  const text = v === undefined ? 'nothing' : typeof v === 'string' ? `“${v}”` : JSON.stringify(v);
  return mask(text).slice(0, 80);
}

/** The outcome of a check from its differences: none → match; otherwise mismatch, or `documented` with a reason. */
export function outcome(
  page: string,
  check: string,
  differences: Difference[],
  documented?: string,
): Outcome {
  if (!differences.length) return { page, check, status: 'match', details: [] };
  if (documented)
    return { page, check, status: 'documented', details: [...differences, `why: ${documented}`] };
  return { page, check, status: 'mismatch', details: differences };
}

const MARK: Record<Status, string> = { match: '✓', mismatch: '✗', documented: '≈', unknowable: '·' };

/** Report lines (masked), then a summary line. */
export function formatOutcomes(outcomes: readonly Outcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    lines.push(mask(`${MARK[o.status]} ${o.page} — ${o.check}`));
    for (const d of o.details) lines.push(mask(`    ${d}`));
  }
  const count = (s: Status) => outcomes.filter((o) => o.status === s).length;
  const pages = new Set(outcomes.map((o) => o.page.split('#')[0])).size;
  lines.push(
    `${outcomes.length} checks on ${pages} definitions: ${count('match')} match, ${count('mismatch')} mismatch, ` +
      `${count('documented')} documented difference, ${count('unknowable')} not knowable.`,
  );
  return lines;
}

/** 1 when any check found an unexplained mismatch. */
export const exitCodeFor = (outcomes: readonly Outcome[]) =>
  outcomes.some((o) => o.status === 'mismatch') ? 1 : 0;

/** Whole days from `now` until `iso` (negative when it has passed), or undefined without a date. */
export function daysUntil(iso: unknown, now: Date): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor((t - now.getTime()) / 86_400_000);
}
