/**
 * Inline Markdown for the widget's small subset: code, strong, emphasis, links and backslash escapes. Pure tokens — the
 * renderer (markdown.tsx) decides what a link may point to and builds the elements.
 *
 * Linear in the text, whatever it holds: every token's scan stops at the next delimiter of its own kind — a code span
 * at the next "`", emphasis at the next "*" or "_", a link label at the next "[" or "]" and a link target at the next
 * "(", ")" or whitespace — so no run of delimiters makes one position scan what the next will scan again. (A label
 * that could hold "[", or a target that could hold "(", made 16,000 "[" take ~360 ms.) The search moves forward with
 * `lastIndex`; nothing is sliced and searched again.
 */

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'link'; target: string; children: InlineToken[] };

const INLINE = [
  /`([^`]+)`/.source, // 1: code
  /\*\*((?:\\.|[^*\\])+)\*\*|__((?:\\.|[^_\\])+)__/.source, // 2, 3: strong
  /\*([^*\s\\](?:\\.|[^*\\])*)\*|_([^_\s\\](?:\\.|[^_\\])*)_/.source, // 4, 5: emphasis
  /\[((?:\\.|[^[\]\\])+)\]\(([^()\s]+)\)/.source, // 6: label, 7: target
  /\\([!-/:-@[-`{-~])/.source, // 8: an escaped punctuation character
].join('|');

export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  // A fresh expression per call: the label and emphasis contents are tokenized recursively.
  const re = new RegExp(INLINE, 'g');
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > from) out.push({ type: 'text', text: text.slice(from, m.index) });
    from = re.lastIndex;
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined)
      out.push({ type: 'strong', children: tokenizeInline((m[2] ?? m[3])!) });
    else if (m[4] !== undefined || m[5] !== undefined)
      out.push({ type: 'em', children: tokenizeInline((m[4] ?? m[5])!) });
    else if (m[6] !== undefined) out.push({ type: 'link', target: m[7]!, children: tokenizeInline(m[6]) });
    else out.push({ type: 'text', text: m[8]! });
  }
  if (from < text.length) out.push({ type: 'text', text: text.slice(from) });
  return out;
}
