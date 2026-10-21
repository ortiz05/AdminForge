/**
 * Content regular expressions: the `pattern:` of page params and playbook/runbook inputs (security review S-14).
 *
 * A JavaScript regex runs synchronously and nothing interrupts it — not the 250 ms transform budget, not a request
 * timeout — so a pattern that backtracks catastrophically (`(a+)+$` on 25 characters took 609 ms) stalls the one
 * event loop that also serves every other request, the run worker and the scheduler. Three rules, here so the API,
 * the engine and the browser apply the same ones:
 *
 * 1. **At validate time** a pattern must compile with the `u` flag, be at most {@link MAX_PATTERN_LENGTH} characters,
 *    and have no nested repetition — a repeated group that itself contains a repetition (`(a+)+`, `(\w*\s?)*`; star
 *    height above 1) — unless every pass of the group starts or ends with a character its inner repetition can't
 *    match (`(\.[a-z0-9]+)*`), which splits a value one way only. No backreferences (`\1`, `\k<name>`). Lookarounds
 *    and bounded group counts (`(\d{1,3}\.){3}`) are fine. `patternProblem` says what is wrong; the param schema
 *    refuses it.
 * 2. **One anchoring rule:** a pattern always describes the whole value. It is compiled as `^(?:<pattern>)$` with
 *    `u`, so `[0-9]+` and `^[0-9]+$` mean the same everywhere (they used to differ between page params and inputs).
 * 3. **Length cap:** a value longer than {@link MAX_PATTERN_INPUT} characters is never run through a pattern.
 *
 * This is a static check, not a proof: overlapping alternatives inside a repetition (`(a|a)*`) are not detected.
 * Bounded inputs (the cap) and the shipped patterns keep that theoretical.
 */

/** Longest `pattern:` content may declare. */
export const MAX_PATTERN_LENGTH = 512;
/** Longest value tested against a content pattern. */
export const MAX_PATTERN_INPUT = 4096;
/** A group repeated more often than this counts as unbounded for the nesting check. */
const BOUNDED_REPEAT = 16;

interface Atom {
  /** Source text of a single-character atom (`a`, `\.`, `[a-z]`, `\w`, `.`); empty for groups and anchors. */
  src: string;
  /** The one character it stands for, when it is a plain or escaped literal. */
  literal?: string;
  group: boolean;
  /** Has any quantifier (then it can't separate repetitions). */
  quantified: boolean;
  /** Repeats (a quantifier with an upper bound above 1), or — for a group — repeats inside. */
  repeats: boolean;
  /** A group that is safe to repeat (see `separated`). */
  separated?: boolean;
}

interface Frame {
  atoms: Atom[];
  alternation: boolean;
}

const canMatch = (atomSrc: string, ch: string): boolean => {
  try {
    return new RegExp(`^(?:${atomSrc})$`, 'u').test(ch);
  } catch {
    return true;
  }
};

/**
 * A repeated group whose every pass starts (or ends) with one mandatory literal character that none of its inner
 * repetitions can match splits a value in exactly one way — `(\.[a-z0-9]+)*`, `([a-z0-9-]{1,63}\.)+` — so repeating
 * it backtracks linearly. Anything else that repeats inside a repetition is refused.
 */
function separated(frame: Frame): boolean {
  if (frame.alternation || frame.atoms.some((a) => a.group && a.repeats)) return false;
  const inner = frame.atoms.filter((a) => a.repeats);
  return [frame.atoms[0], frame.atoms[frame.atoms.length - 1]].some(
    (edge) =>
      edge?.literal !== undefined && !edge.quantified && inner.every((a) => !canMatch(a.src, edge.literal!)),
  );
}

/** Nested repetition or a backreference in `source`, as a sentence fragment; undefined when there is none. */
function structureProblem(source: string): string | undefined {
  const stack: Frame[] = [{ atoms: [], alternation: false }];
  const top = () => stack[stack.length - 1]!;
  const push = (atom: Omit<Atom, 'quantified' | 'repeats' | 'group'> & Partial<Atom>) =>
    top().atoms.push({ group: false, quantified: false, repeats: false, ...atom });
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      const n = source[i + 1] ?? '';
      if (/[1-9]/.test(n) || (n === 'k' && source[i + 2] === '<'))
        return 'uses a backreference (\\1 or \\k<name>)';
      const start = i;
      if ((n === 'u' || n === 'p' || n === 'P') && source[i + 2] === '{') {
        const close = source.indexOf('}', i + 3);
        i = close < 0 ? source.length : close + 1;
      } else i += 2;
      const src = source.slice(start, i);
      push({ src, ...(/^[^A-Za-z0-9]$/.test(n) ? { literal: n } : {}) });
      continue;
    }
    if (c === '[') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
      push({ src: source.slice(start, i) });
      continue;
    }
    if (c === '(') {
      if (/^\(\?(?:[:=!]|<[=!])/.test(source.slice(i, i + 4))) i += source[i + 2] === '<' ? 4 : 3;
      else if (source.startsWith('(?<', i)) {
        const close = source.indexOf('>', i);
        i = close < 0 ? source.length : close + 1;
      } else i++;
      stack.push({ atoms: [], alternation: false });
      continue;
    }
    if (c === ')') {
      i++;
      const frame = stack.length > 1 ? stack.pop()! : { atoms: [], alternation: false };
      push({
        src: '',
        group: true,
        repeats: frame.atoms.some((a) => a.repeats),
        separated: separated(frame),
      });
      continue;
    }
    if (c === '|') {
      top().alternation = true;
      push({ src: '' });
      i++;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let max: number;
      if (c === '{') {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i, i + 24));
        if (!m) {
          // A literal brace (the `u` compile refuses it anyway).
          i++;
          push({ src: '' });
          continue;
        }
        max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
        i += m[0].length;
      } else {
        max = c === '?' ? 1 : Infinity;
        i++;
      }
      if (source[i] === '?') i++; // lazy
      const last = top().atoms[top().atoms.length - 1];
      if (!last) continue;
      if (last.group && last.repeats && !last.separated && max > BOUNDED_REPEAT)
        return 'repeats a group that itself repeats (like (a+)+), which can take seconds on a short value';
      last.quantified = true;
      if (max > 1) last.repeats = true;
      continue;
    }
    push({ src: c === '^' || c === '$' ? '' : c, ...(/[^.^$]/.test(c) ? { literal: c } : {}) });
    i++;
  }
  return undefined;
}

/**
 * Why `source` can't be a content pattern, as a sentence for the content author; undefined when it is fine.
 * Used by the param schema, so `adminforge validate` and publishing refuse it.
 */
export function patternProblem(source: string): string | undefined {
  if (source.length > MAX_PATTERN_LENGTH)
    return `The pattern is longer than ${MAX_PATTERN_LENGTH} characters; describe the value more simply.`;
  try {
    new RegExp(anchored(source), 'u');
  } catch (e) {
    return `The pattern is not a valid regular expression (with the u flag): ${(e as Error).message}`;
  }
  const problem = structureProblem(source);
  return problem
    ? `The pattern ${problem}. Start or end each repeated part with a character the part can't otherwise contain — ([a-z0-9-]+\\.)+, not ([a-z0-9.-]+)+ — or use one character class with a length, like [a-z0-9.-]{1,253}.`
    : undefined;
}

const anchored = (source: string) => `^(?:${source})$`;

const compiled = new Map<string, RegExp | null>();

/** The compiled, anchored pattern; null when it is not an allowed content pattern (see {@link patternProblem}). */
export function contentPattern(source: string): RegExp | null {
  let re = compiled.get(source);
  if (re === undefined) {
    re = patternProblem(source) ? null : new RegExp(anchored(source), 'u');
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, re);
  }
  return re;
}

export type PatternResult = 'match' | 'mismatch' | 'too_long' | 'invalid';

/** Tests a whole value against a content pattern under the three rules above. */
export function testContentPattern(source: string, value: string): PatternResult {
  const re = contentPattern(source);
  if (!re) return 'invalid';
  if (value.length > MAX_PATTERN_INPUT) return 'too_long';
  return re.test(value) ? 'match' : 'mismatch';
}
