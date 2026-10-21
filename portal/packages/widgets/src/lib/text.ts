import { useEffect, useMemo, useState } from 'react';
import { evaluate, splitTemplate, type Scope } from '@adminforge/expressions';
import { escapeMarkdownInline } from '@adminforge/ui';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Runs a tag pattern over the text up to its last `>` and keeps the rest as it is. Every tag pattern here ends with
 * `>`, so nothing after the last one can match — and before it, a pattern's scan for its `>` always succeeds. Without
 * this, each `<` of a hostile value ("<a x<a x…", 64,000 "<") would scan to the end of the text: seconds of frozen
 * page for one table cell.
 */
function beforeLastGt(s: string, pass: (markup: string) => string): string {
  const end = s.lastIndexOf('>') + 1;
  return end === s.length ? pass(s) : pass(s.slice(0, end)) + s.slice(end);
}

const looksLikeHtml = (s: string) =>
  s.includes('>') && /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s.slice(0, s.lastIndexOf('>') + 1));

/**
 * Removes `<script>` and `<style>` elements with their content. An element that is never closed stays (its tag is
 * dropped with the others); once no end tag follows, no later element of that name is searched again, so this is one
 * forward pass.
 */
function dropScripts(s: string): string {
  const open = /<(script|style)[^<>]*>/gi;
  const unclosed = new Set<string>();
  let out = '';
  let kept = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const name = m[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}>`, 'gi');
    close.lastIndex = open.lastIndex;
    const end = close.exec(s);
    if (!end) {
      unclosed.add(name);
      continue;
    }
    out += s.slice(kept, m.index);
    kept = open.lastIndex = end.index + end[0].length;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

/** Spaces and tabs at the end of each line (a hand-written loop: `/[ \t]+\n/` is quadratic on a long run of spaces). */
function trimLineEnds(s: string): string {
  return s
    .split('\n')
    .map((line) => {
      let end = line.length;
      while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
      return end === line.length ? line : line.slice(0, end);
    })
    .join('\n');
}

/**
 * The character a numeric reference (`#65`, `#x41`, lower-cased) names, or null when it names none: zero, past
 * U+10FFFF, a surrogate, or not a plain number. `String.fromCodePoint` throws on the first two, and a throw while a
 * widget renders would take the page down, so such a reference stays as written. Same rule as the API's feed text
 * (`apps/api/src/news/text.ts`).
 */
function numericReference(ref: string): string | null {
  const digits = /^#(?:x([0-9a-f]+)|([0-9]+))$/.exec(ref);
  if (!digits) return null;
  const n = digits[1] !== undefined ? parseInt(digits[1], 16) : Number(digits[2]);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  return String.fromCodePoint(n);
}

/** Line breaks, list items and block ends become line structure; every other tag goes. */
const TAG_PASSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/<br\s*\/?>/gi, '\n'],
  [/<li[^>]*>/gi, '\n- '],
  [/<\/(p|div|h[1-6]|ul|ol|li|tr|table|section|article|blockquote)>/gi, '\n\n'],
  [/<[^>]+>/g, ''],
];

/**
 * HTML from Microsoft APIs (message center posts, service health updates) → plain text with paragraph breaks.
 * Nothing is ever rendered as HTML: tags are dropped (block tags become line breaks, list items become "- ")
 * and entities decoded. Script/style contents are removed entirely. Every pass is linear in the input: this runs
 * while widgets render, and tenant text can be crafted.
 */
export function htmlToText(input: string): string {
  if (!looksLikeHtml(input)) return input;
  let text = dropScripts(input);
  // Each pass on its own text up to the last `>`: an earlier pass may have removed the one that ended it.
  for (const [pattern, replacement] of TAG_PASSES)
    text = beforeLastGt(text, (markup) => markup.replace(pattern, replacement));
  text = text.replace(/&(#?[a-z0-9]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k]) return ENTITIES[k]!;
    if (k.startsWith('#')) return numericReference(k) ?? m;
    return m;
  });
  return trimLineEnds(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Display text for any value: HTML stripped, objects as JSON, blanks as ''. */
export function toText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return htmlToText(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function interpolate(source: string, scope: Scope): Promise<string> {
  let out = '';
  for (const seg of splitTemplate(source))
    out += seg.type === 'text' ? seg.value : escapeMarkdownInline(toText(await evaluate(seg.source, scope)));
  return out;
}

/**
 * Templated text (`markdown.text`): literal parts stay as written (they are Markdown), values from `${ … }` are
 * converted to plain text and their inline Markdown escaped first, so neither HTML nor Markdown coming from data (a
 * display name like `[Open](/admin)`) can become markup or a link. Line structure stays: HTML lists from Microsoft
 * APIs keep showing as lists.
 */
export function useInterpolatedText(
  source: string,
  scope: Scope,
): { text: string | undefined; error?: Error } {
  const templated = source.includes('${');
  const key = useMemo(() => ({ source, scope }), [source, scope]);
  const [state, setState] = useState<{ for: unknown; text?: string; error?: Error }>({ for: null });
  useEffect(() => {
    if (!templated) return;
    let live = true;
    interpolate(key.source, key.scope).then(
      (text) => live && setState({ for: key, text }),
      (error: Error) => live && setState({ for: key, error }),
    );
    return () => {
      live = false;
    };
  }, [key, templated]);
  if (!templated) return { text: source.replace(/\$\$\{/g, '${') };
  return state.for === key ? { text: state.text, error: state.error } : { text: undefined };
}
