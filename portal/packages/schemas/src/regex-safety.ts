/**
 * Content regular expressions: the `pattern:` of page params and playbook/runbook inputs (security review S-14).
 *
 * A JavaScript regex runs synchronously and nothing interrupts it — not the 250 ms transform budget, not a request
 * timeout — so a pattern that backtracks catastrophically (`(a+)+$` on 25 characters took 609 ms) stalls the one
 * event loop that also serves every other request, the run worker and the scheduler. Three rules, here so the API,
 * the engine and the browser apply the same ones:
 *
 * 1. **At validate time** a pattern must compile with the `u` flag, be at most {@link MAX_PATTERN_LENGTH} characters
 *    and avoid the shapes that backtrack without bound:
 *    - a repetition inside a repeated group (`(a+)+`, `(\w*\s?)*`, `(a+){16}`; star height above 1) — unless every
 *      pass of the group starts or ends with one mandatory character its inner repetition can't match
 *      (`(\.[a-z0-9]+)*`, `([a-z0-9-]{1,63}\.)+`), which splits a value one way only;
 *    - a repeated choice whose alternatives can start alike (`(a|a)*`, `(.|\s)*`) — alternatives must start with
 *      different mandatory characters (`(?:Include|Exclude)+`);
 *    - two repetitions side by side that can match the same characters (`\d*\d*`, `[a-z]+[a-z0-9]*`), also across
 *      optional or shared characters between them (`\d+0?\d+`);
 *    - backreferences (`\1`, `\k<name>`) and inline flag groups (`(?i:…)`), which change what the rest matches.
 *    Lookarounds and fixed counts (`(\d{1,3}\.){3}`) are fine. `patternProblem` says what is wrong; the param schema
 *    refuses it.
 * 2. **One anchoring rule:** a pattern always describes the whole value. It is compiled as `^(?:<pattern>)$` with
 *    `u`, so `[0-9]+` and `^[0-9]+$` mean the same everywhere (they used to differ between page params and inputs).
 * 3. **Length cap:** a value longer than {@link MAX_PATTERN_INPUT} characters is never run through a pattern.
 *
 * This is a static check over the pattern's structure, not a proof: overlap is judged on a sample of characters, and
 * repetitions inside groups are compared within their group only. A linear-time engine as a runtime backstop is in
 * the backlog.
 */

/** Longest `pattern:` content may declare. */
export const MAX_PATTERN_LENGTH = 512;
/** Longest value tested against a content pattern. */
export const MAX_PATTERN_INPUT = 4096;

interface Atom {
  /** Source of a single-character atom (`a`, `\.`, `\x61`, `[a-z]`, `\w`, `.`); empty for groups and anchors. */
  src: string;
  /** The one character it stands for, when it is a plain or escaped literal. */
  literal?: string;
  group: boolean;
  /** Matches no character: an anchor, a word boundary or a lookaround. */
  zeroWidth: boolean;
  min: number;
  max: number;
  /** Has any quantifier (then it can't separate repetitions). */
  quantified: boolean;
  /** Repeats (an upper bound above 1), or — for a group — something inside repeats. */
  repeats: boolean;
  /** Group: safe to repeat although it repeats inside (see `separated`). */
  separated?: boolean;
  /** Group: has alternatives, and whether they start with different mandatory characters. */
  alternation?: boolean;
  distinctStarts?: boolean;
}

interface Frame {
  branches: Atom[][];
  lookaround: boolean;
}

/** Characters overlap is judged on: ASCII plus a few letters, digits and spaces from elsewhere in Unicode. */
const SAMPLE = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), ...'éßΩжא中٣  　'];

/** `u`, plus `i` when the pattern ignores case (a regex literal in an expression: `/…/i`). */
type Flags = 'u' | 'ui';

const atomRegexes = new Map<string, RegExp | null>();
function canMatch(atomSrc: string, ch: string, flags: Flags): boolean {
  const key = `${flags}:${atomSrc}`;
  let re = atomRegexes.get(key);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${atomSrc})$`, flags);
    } catch {
      re = null;
    }
    if (atomRegexes.size > 2000) atomRegexes.clear();
    atomRegexes.set(key, re);
  }
  return re ? re.test(ch) : true;
}

const overlap = (a: Atom, b: Atom, flags: Flags) =>
  SAMPLE.some((ch) => canMatch(a.src, ch, flags) && canMatch(b.src, ch, flags));

const variable = (a: Atom) => !a.group && !a.zeroWidth && a.max > 1 && a.max !== a.min;

/** Two repetitions of the same characters side by side (`\d*\d*`): the engine tries every split between them. */
function adjacentProblem(atoms: Atom[], flags: Flags): string | undefined {
  let open: Atom | null = null;
  for (const a of atoms) {
    if (a.zeroWidth) continue;
    if (a.group) {
      open = null;
      continue;
    }
    if (variable(a)) {
      if (open && overlap(open, a, flags))
        return 'puts two repetitions that can match the same characters side by side (like \\d*\\d*)';
      open = a;
    } else if (a.min > 0 && !(open && overlap(open, a, flags))) open = null;
  }
  return undefined;
}

/**
 * A repeated group whose every pass starts (or ends) with one mandatory literal character that none of its inner
 * repetitions can match splits a value in exactly one way — `(\.[a-z0-9]+)*`, `([a-z0-9-]{1,63}\.)+` — so repeating
 * it backtracks linearly.
 */
function separated(atoms: Atom[], flags: Flags): boolean {
  if (atoms.some((a) => a.group && a.repeats)) return false;
  const inner = atoms.filter((a) => a.repeats);
  return [atoms[0], atoms[atoms.length - 1]].some(
    (edge) =>
      edge?.literal !== undefined &&
      !edge.quantified &&
      inner.every((a) => !canMatch(a.src, edge.literal!, flags)),
  );
}

const CONTROL_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', '0': '\0' };

/** The atom an escape starts at `i`, and where it ends; a problem for backreferences. */
function escapeAt(source: string, i: number): { atom: Partial<Atom>; end: number } | { problem: string } {
  const n = source[i + 1] ?? '';
  if (/[1-9]/.test(n) || (n === 'k' && source[i + 2] === '<'))
    return { problem: 'uses a backreference (\\1 or \\k<name>)' };
  const hex = (re: RegExp) => re.exec(source.slice(i));
  let m: RegExpExecArray | null;
  if (
    (m = hex(/^\\x([0-9A-Fa-f]{2})/)) ||
    (m = hex(/^\\u([0-9A-Fa-f]{4})/)) ||
    (m = hex(/^\\u\{([0-9A-Fa-f]+)\}/))
  ) {
    const cp = Number.parseInt(m[1]!, 16);
    return {
      atom: { src: m[0], ...(cp <= 0x10ffff ? { literal: String.fromCodePoint(cp) } : {}) },
      end: i + m[0].length,
    };
  }
  if ((m = hex(/^\\c([A-Za-z])/)))
    return { atom: { src: m[0], literal: String.fromCharCode(m[1]!.charCodeAt(0) % 32) }, end: i + 3 };
  if ((m = hex(/^\\[pP]\{[^}]*\}/))) return { atom: { src: m[0] }, end: i + m[0].length };
  if (n === 'b' || n === 'B') return { atom: { src: '', zeroWidth: true }, end: i + 2 };
  if (/[dDwWsS]/.test(n)) return { atom: { src: `\\${n}` }, end: i + 2 };
  if (n in CONTROL_ESCAPES) return { atom: { src: `\\${n}`, literal: CONTROL_ESCAPES[n] }, end: i + 2 };
  return { atom: { src: `\\${n}`, ...(/[^A-Za-z0-9]/.test(n) ? { literal: n } : {}) }, end: i + 2 };
}

/** A shape in `source` that can backtrack without bound, as a sentence fragment; undefined when there is none. */
function structureProblem(source: string, flags: Flags): string | undefined {
  const stack: Frame[] = [{ branches: [[]], lookaround: false }];
  const top = () => stack[stack.length - 1]!;
  const branch = () => top().branches[top().branches.length - 1]!;
  const push = (a: Partial<Atom>) =>
    branch().push({
      src: '',
      group: false,
      zeroWidth: false,
      min: 1,
      max: 1,
      quantified: false,
      repeats: false,
      ...a,
    });
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      const e = escapeAt(source, i);
      if ('problem' in e) return e.problem;
      push(e.atom);
      i = e.end;
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
      let lookaround = false;
      if (source.startsWith('(?:', i)) i += 3;
      else if (source.startsWith('(?=', i) || source.startsWith('(?!', i)) {
        lookaround = true;
        i += 3;
      } else if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
        lookaround = true;
        i += 4;
      } else if (/^\(\?<[A-Za-z_$][\w$]*>/.test(source.slice(i))) i = source.indexOf('>', i) + 1;
      else if (source.startsWith('(?', i))
        return 'uses inline flags or a group form content patterns do not accept';
      else i++;
      stack.push({ branches: [[]], lookaround });
      continue;
    }
    if (c === ')') {
      i++;
      if (stack.length === 1) continue; // unbalanced: the compile refuses it
      const frame = stack.pop()!;
      for (const b of frame.branches) {
        const p = adjacentProblem(b, flags);
        if (p) return p;
      }
      const atoms = frame.branches.flat();
      const alternation = frame.branches.length > 1;
      const starts = frame.branches.map((b) => b[0]);
      push({
        group: true,
        zeroWidth: frame.lookaround,
        repeats: atoms.some((a) => a.repeats),
        separated: !alternation && separated(atoms, flags),
        alternation,
        distinctStarts:
          alternation &&
          starts.every((a) => a?.literal !== undefined && !a.quantified) &&
          new Set(starts.map((a) => (flags === 'ui' ? a!.literal!.toLowerCase() : a!.literal))).size ===
            starts.length,
      });
      continue;
    }
    if (c === '|') {
      top().branches.push([]);
      i++;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let min: number;
      let max: number;
      if (c === '{') {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
        if (!m) {
          // A literal brace (the `u` compile refuses it anyway).
          push({ src: '\\{', literal: '{' });
          i++;
          continue;
        }
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        i += m[0].length;
      } else {
        min = c === '+' ? 1 : 0;
        max = c === '?' ? 1 : Infinity;
        i++;
      }
      if (source[i] === '?') i++; // lazy
      const last = branch()[branch().length - 1];
      if (!last) continue;
      if (last.group && max > 1) {
        if (last.repeats && !last.separated)
          return 'repeats a group that itself repeats (like (a+)+), which can take seconds on a short value';
        if (last.alternation && !last.distinctStarts)
          return 'repeats a choice between alternatives that can start alike (like (a|a)* or (.|\\s)*)';
      }
      last.min = min;
      last.max = max;
      last.quantified = true;
      if (max > 1) last.repeats = true;
      continue;
    }
    if (c === '^' || c === '$') push({ zeroWidth: true });
    else
      push({
        src: c === '.' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'),
        ...(c === '.' ? {} : { literal: c }),
      });
    i++;
  }
  for (const b of stack[0]!.branches) {
    const p = adjacentProblem(b, flags);
    if (p) return p;
  }
  return undefined;
}

/**
 * Why `source` can't be a content pattern, as a sentence for the content author; undefined when it is fine.
 * Used by the param schema, so `adminforge validate` and publishing refuse it — and by the expressions' validation for
 * regular expressions written into an expression, with `ignoreCase` for an `/…/i` (then `a` and `A` overlap, and
 * `(?:a|A)+` repeats alternatives that start alike).
 */
export function patternProblem(source: string, opts: { ignoreCase?: boolean } = {}): string | undefined {
  const flags: Flags = opts.ignoreCase ? 'ui' : 'u';
  if (source.length > MAX_PATTERN_LENGTH)
    return `The pattern is longer than ${MAX_PATTERN_LENGTH} characters; describe the value more simply.`;
  try {
    new RegExp(anchored(source), flags);
  } catch (e) {
    return `The pattern is not a valid regular expression (with the u flag): ${(e as Error).message}`;
  }
  const problem = structureProblem(source, flags);
  return problem
    ? `The pattern ${problem}. Describe each part once: one character class with a length ([a-z0-9.-]{1,253}), repeated parts that start or end with a character they can't otherwise contain (([a-z0-9-]+\\.)+), alternatives that start differently.`
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
