/**
 * Plain text from feed content. Sources send HTML (Message Center bodies, RSS descriptions); AdminForge keeps only plain
 * text — tags removed, entities decoded, control and bidirectional-override characters dropped, whitespace collapsed — so
 * nothing from a source is ever rendered as markup.
 */

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** HTML named entities worth decoding in feed text (others stay as written). */
const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  rarr: '→',
  larr: '←',
  euro: '€',
  pound: '£',
  shy: '',
  zwnj: '',
  zwj: '',
};

function codePoint(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  return String.fromCodePoint(n);
}

function decodeWith(text: string, table: Record<string, string>): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, ref: string) => {
    if (ref[0] === '#')
      return codePoint(ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    const named = table[ref] ?? table[ref.toLowerCase()];
    return named ?? whole;
  });
}

/** The five XML entities and numeric character references; nothing else (no DTD-defined entities). */
export const decodeXmlEntities = (text: string) => decodeWith(text, XML_ENTITIES);

export const decodeHtmlEntities = (text: string) => decodeWith(text, HTML_ENTITIES);

// C0 (except tab/newline/CR), DEL, C1, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width space,
// bidi marks/embeddings/overrides/isolates, word joiner and invisible operators, BOM, interlinear annotation marks and
// the tag characters — none of them is visible text, and several can disguise what a line says.
const CONTROL =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

/**
 * Feed text is cut to this many characters before any pattern runs over it: AdminForge keeps at most a few hundred
 * characters of any field, and no pattern then sees more than this (a hostile or broken source can't make the scheduler
 * spend minutes on one field).
 */
export const MAX_SOURCE_CHARS = 64 * 1024;

const cap = (text: string) => (text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text);

/** Drops control, bidi-override and invisible characters and collapses whitespace to single spaces. */
export function cleanText(text: string): string {
  return cap(text)
    .replace(CONTROL, '')
    .replace(/[\s\u2028\u2029]+/g, ' ')
    .trim();
}

/** Elements whose content is never text. */
const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'svg', 'head']);
/** Block boundaries become spaces so words don't run together. */
const BLOCKS = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'tr',
  'td',
  'th',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'section',
  'article',
  'hr',
]);
const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9-]{0,31})/;

/**
 * Removes markup in one forward pass (linear in the input): comments, declarations, tags, and the content of
 * script/style-like elements. (CDATA markers are unwrapped beforehand, so their content is read as markup too.) A `<` that doesn't start a tag stays as text; a tag that never closes
 * ends the text (it was cut off).
 */
function stripMarkup(src: string): string {
  let out = '';
  let i = 0;
  // Position of the next ">" at or after the last search start (searches only move forward).
  let gt = -2;
  const nextGt = (from: number) => {
    if (gt === -1 || gt >= from) return gt;
    gt = src.indexOf('>', from);
    return gt;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) break;
      out += ' ';
      i = end + 3;
      continue;
    }
    const m = TAG_NAME.exec(src.slice(lt, lt + 40));
    const declaration = src[lt + 1] === '!' || src[lt + 1] === '?';
    if (!m && !declaration) {
      // "a < b": not markup.
      out += '<';
      i = lt + 1;
      continue;
    }
    const close = nextGt(lt);
    if (close === -1) break;
    i = close + 1;
    if (!m) {
      out += ' ';
      continue;
    }
    const name = m[2]!.toLowerCase();
    const closing = m[1] === '/';
    if (!closing && SKIPPED.has(name) && src[close - 1] !== '/') {
      const end = new RegExp(`</${name}\\s*>`, 'gi');
      end.lastIndex = i;
      const found = end.exec(src);
      if (!found) break;
      i = found.index + found[0].length;
      out += ' ';
      continue;
    }
    if (BLOCKS.has(name)) out += ' ';
  }
  return out;
}

/** HTML (or text with stray markup) → one line of plain text. */
export function htmlToText(html: string): string {
  const src = cap(html).replaceAll('<![CDATA[', '').replaceAll(']]>', '');
  return cleanText(decodeHtmlEntities(stripMarkup(src)));
}

/** Cuts plain text at `max` characters on a word boundary, ending with "…". */
export function excerpt(text: string, max: number): string {
  const clean = cleanText(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  // The cut ends a word when the next character is a space; otherwise step back to the last whole word.
  const space = clean[max - 1] === ' ' ? cut.length : cut.lastIndexOf(' ');
  const base = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.–—-]+$/, '')}…`;
}

export const TITLE_MAX = 300;

/** A title as plain text, at most 300 characters. */
export const cleanTitle = (text: string) => excerpt(htmlToText(text), TITLE_MAX);

/** A short fact value (≤ 200 characters). */
export const factValue = (text: string) => excerpt(cleanText(text), 200);
