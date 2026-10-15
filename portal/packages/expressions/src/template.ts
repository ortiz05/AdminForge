/**
 * `${ … }` templates (§7.6). Scanning is brace-depth and string-literal aware, so JSONata object constructors
 * (`${ { "a": 1 } }`) and strings containing braces (`${ "}" }`) work. `$${` is a literal `${`.
 */

export type TemplateSegment =
  { type: 'text'; value: string } | { type: 'expr'; source: string; start: number; end: number };

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly template: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

function skipString(str: string, open: number): number {
  const quote = str[open];
  for (let j = open + 1; j < str.length; j++) {
    if (str[j] === '\\' && quote !== '`') j++;
    else if (str[j] === quote) return j;
  }
  throw new TemplateError(`Unterminated string literal in \${ … } at position ${open}`, str, open);
}

/** Index of the `}` closing the expression whose body starts at `from`. */
function scanExpression(str: string, from: number): number {
  let depth = 0;
  for (let i = from; i < str.length; i++) {
    const c = str[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(str, i);
    else if (c === '/' && str[i + 1] === '*') {
      const close = str.indexOf('*/', i + 2);
      if (close < 0) throw new TemplateError(`Unterminated comment in \${ … } at position ${i}`, str, i);
      i = close + 1;
    } else if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  throw new TemplateError(`Unterminated \${ … } starting at position ${from - 2}`, str, from - 2);
}

/** Splits a template into literal text and expression segments. Throws TemplateError on unbalanced input. */
export function splitTemplate(str: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let text = '';
  let i = 0;
  while (i < str.length) {
    if (str.startsWith('$${', i)) {
      text += '${';
      i += 3;
    } else if (str.startsWith('${', i)) {
      const end = scanExpression(str, i + 2);
      const source = str.slice(i + 2, end).trim();
      if (!source) throw new TemplateError(`Empty \${ } at position ${i}`, str, i);
      if (text) out.push({ type: 'text', value: text });
      text = '';
      out.push({ type: 'expr', source, start: i, end: end + 1 });
      i = end + 1;
    } else {
      text += str[i];
      i++;
    }
  }
  if (text) out.push({ type: 'text', value: text });
  return out;
}

/** True when the string contains at least one `${` (escaped `$${` counts, so callers still unescape it). */
export const hasTemplate = (str: string): boolean => str.includes('${');

/** The expression source when the template is exactly one `${ … }` (surrounding whitespace allowed), else undefined. */
export function wholeExpression(segments: readonly TemplateSegment[]): string | undefined {
  const exprs = segments.filter((s) => s.type === 'expr');
  if (exprs.length !== 1) return undefined;
  const textOnlyWhitespace = segments.every((s) => s.type === 'expr' || /^\s*$/.test(s.value));
  return textOnlyWhitespace ? (exprs[0] as { source: string }).source : undefined;
}
