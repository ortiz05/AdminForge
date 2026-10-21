/**
 * Typed confirmations (a playbook's `confirm: { type: typed }`): the one comparison the browser (whether Run can be
 * pressed) and the API (whether the run starts) use, and what the person is told about the text they type.
 *
 * The expected text often comes from the tenant — an app's display name is chosen by whoever registered the app — so
 * it may carry characters that can't be seen (zero-width spaces, bidi controls) or that only look like plain letters
 * (a Cyrillic letter for its Latin twin). The comparison ignores what can't be seen and folds what Unicode says is
 * the same text (NFKC: full-width and mathematical letters, ligatures, non-breaking spaces; case folding also matches
 * a dotless i to i), but keeps letters of other scripts distinct. Either way `unusualCharacters` lists them for the
 * person, so a name made to pass for another one is seen before anything changes. The object itself is fixed by id
 * in the preview; the typed text makes sure the person looked at which one it is.
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

/** Bidirectional formatting characters: in tenant text they can reorder what is shown around them. */
const BIDI_CONTROLS = /[\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** Tenant text to show as written: without bidi controls (an app name can't reverse the sentence it sits in). */
export const withoutBidiControls = (text: string): string => text.replace(BIDI_CONTROLS, '');

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
  /** A letter's script (`Cyrillic`), when it is one of those named here. */
  script: string | null;
  /** It takes no room on screen (zero-width, bidi control): show a marker where it sits. */
  invisible: boolean;
  /**
   * It can make the text pass for other text: an invisible character, a space that isn't the plain one, a styled
   * letter or digit (full-width, mathematical, ligature), or a letter of another script mixed into a word of Latin,
   * Cyrillic, Greek… letters (the look-alike scripts) — including a plain Latin letter in a Cyrillic name. Other
   * unusual characters (accents, curly quotes, a name written in Japanese) are only hard to type.
   */
  misleading: boolean;
}

/** Scripts named for a person, so they recognise where a letter comes from. */
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
/** Scripts whose letters pass for one another's (Latin "a", Cyrillic "а", Greek "α"). */
const LOOK_ALIKE_SCRIPTS = new Set([
  'Latin',
  'Cyrillic',
  'Greek',
  'Armenian',
  'Cherokee',
  'Coptic',
  'Georgian',
]);
const SCRIPT_RE = SCRIPTS.map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, 'u')] as const);

const codePointOf = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
const scriptOf = (ch: string): string | null =>
  /^\p{L}$/u.test(ch) ? (SCRIPT_RE.find(([, re]) => re.test(ch))?.[0] ?? null) : null;

function kindOf(ch: string): Omit<UnusualCharacter, 'char' | 'codePoint'> {
  const script = scriptOf(ch);
  if (IS_INVISIBLE.test(ch))
    return { kind: 'invisible character', script, invisible: true, misleading: true };
  if (/^\s$/u.test(ch)) return { kind: 'space', script, invisible: false, misleading: true };
  const compat = ch.normalize('NFKC');
  if (compat !== ch && strip(compat).trim() !== '')
    return {
      kind: `different form of “${compat}”`,
      script,
      invisible: false,
      misleading: /^[\p{L}\p{N}\p{P}]$/u.test(ch),
    };
  const plain = { script, invisible: false, misleading: false };
  if (script) return { kind: `${script} letter`, ...plain };
  if (/^\p{L}$/u.test(ch)) return { kind: 'letter', ...plain };
  if (/^\p{M}$/u.test(ch)) return { kind: 'accent mark', ...plain };
  if (/^\p{Nd}$/u.test(ch)) return { kind: 'digit', ...plain };
  if (/^\p{P}$/u.test(ch)) return { kind: 'punctuation', ...plain };
  if (/^\p{S}$/u.test(ch)) return { kind: 'symbol', ...plain };
  return { kind: 'character', ...plain };
}

/**
 * The script most of the text's look-alike-script letters are in (Latin wins a tie): letters of the others are mixed
 * in. Null when the text has letters of at most one of those scripts.
 */
function mainScript(text: string): string | null {
  const counts = new Map<string, number>();
  for (const ch of text) {
    const script = scriptOf(ch);
    if (script && LOOK_ALIKE_SCRIPTS.has(script)) counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (counts.size < 2) return null;
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] === 'Latin' ? -1 : b[0] === 'Latin' ? 1 : 0))[0]![0];
}

/**
 * Every character of `text` that isn't plain printable ASCII — and, in a name mixing look-alike scripts, every letter
 * outside its main script, plain Latin ones included — once each in order of appearance: what to point out next to the
 * text to type, so a look-alike or hidden character is seen before anything changes.
 */
export function unusualCharacters(text: string): UnusualCharacter[] {
  const main = mainScript(text);
  const seen = new Set<string>();
  const out: UnusualCharacter[] = [];
  for (const ch of text) {
    if (seen.has(ch)) continue;
    const script = scriptOf(ch);
    const mixedIn = main !== null && script !== null && LOOK_ALIKE_SCRIPTS.has(script) && script !== main;
    if (PLAIN.test(ch) && !mixedIn) continue;
    seen.add(ch);
    const kind = kindOf(ch);
    out.push({ char: ch, codePoint: codePointOf(ch), ...kind, misleading: kind.misleading || mixedIn });
  }
  return out;
}
