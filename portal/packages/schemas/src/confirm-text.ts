/**
 * Typed confirmations (a playbook's `confirm: { type: typed }`): the one comparison the browser (whether Run can be
 * pressed) and the API (whether the run starts) use, and what the person is told about the text they type.
 *
 * The expected text often comes from the tenant — an app's display name is chosen by whoever registered the app — so
 * it may carry characters that can't be seen (zero-width spaces, bidi controls) or that only look like plain letters
 * (a Cyrillic letter for its Latin twin). The comparison ignores what can't be seen and folds what Unicode says is the same text
 * (NFKC: full-width letters, ligatures, non-breaking spaces), but keeps letters of other scripts distinct: those are
 * listed for the person by `unusualCharacters`, so a look-alike is noticed rather than matched.
 */

/** Characters that show nothing: format characters (Cf) and the other default-ignorable code points. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const IS_INVISIBLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
/** Plain text: printable ASCII (letters, digits, the space and punctuation). */
const PLAIN = /^[\x20-\x7e]$/;

const strip = (s: string) => s.replace(INVISIBLE, '');

/**
 * The form both sides compare: invisible characters removed, Unicode NFKC, whitespace collapsed and trimmed, case
 * folded (upper- then lower-cased, so sharp s and `SS`, or the two Greek sigmas, compare equal).
 */
export function normalizeConfirmation(text: string): string {
  return strip(strip(text).normalize('NFKC'))
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
}

/** Whether what the person typed confirms `expected`. An expected value with nothing visible in it never matches. */
export function confirmationMatches(typed: string | null | undefined, expected: string): boolean {
  if (typeof typed !== 'string') return false;
  const want = normalizeConfirmation(expected);
  return want !== '' && normalizeConfirmation(typed) === want;
}

export interface UnusualCharacter {
  /** The character as it appears in the text. */
  char: string;
  /** `U+0430` */
  codePoint: string;
  /** What it is, in words: `Cyrillic letter`, `invisible character`, `space`, `different form of “A”`, … */
  kind: string;
  /** It takes no room on screen (zero-width, bidi control): show a marker where it sits. */
  invisible: boolean;
}

/** Scripts look-alike letters come from, named so a person recognises them. */
const SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Armenian',
  'Cherokee',
  'Coptic',
  'Georgian',
  'Hebrew',
  'Arabic',
  'Devanagari',
  'Thai',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
] as const;
const SCRIPT_RE = SCRIPTS.map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, 'u')] as const);

const codePointOf = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

function kindOf(ch: string): { kind: string; invisible: boolean } {
  if (IS_INVISIBLE.test(ch)) return { kind: 'invisible character', invisible: true };
  if (/^\s$/u.test(ch)) return { kind: 'space', invisible: false };
  const compat = ch.normalize('NFKC');
  if (compat !== ch && strip(compat).trim() !== '')
    return { kind: `different form of “${compat}”`, invisible: false };
  if (/^\p{L}$/u.test(ch)) {
    const script = SCRIPT_RE.find(([, re]) => re.test(ch))?.[0];
    return { kind: script ? `${script} letter` : 'letter', invisible: false };
  }
  if (/^\p{M}$/u.test(ch)) return { kind: 'accent mark', invisible: false };
  if (/^\p{Nd}$/u.test(ch)) return { kind: 'digit', invisible: false };
  if (/^\p{P}$/u.test(ch)) return { kind: 'punctuation', invisible: false };
  if (/^\p{S}$/u.test(ch)) return { kind: 'symbol', invisible: false };
  return { kind: 'character', invisible: false };
}

/**
 * Every character of `text` that isn't plain printable ASCII, once each in order of appearance: what to point out
 * next to the text to type, so a look-alike or hidden character is seen before anything changes.
 */
export function unusualCharacters(text: string): UnusualCharacter[] {
  const seen = new Set<string>();
  const out: UnusualCharacter[] = [];
  for (const ch of text) {
    if (PLAIN.test(ch) || seen.has(ch)) continue;
    seen.add(ch);
    out.push({ char: ch, codePoint: codePointOf(ch), ...kindOf(ch) });
  }
  return out;
}
