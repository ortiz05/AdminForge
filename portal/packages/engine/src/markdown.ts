import { evaluate, splitTemplate, type Scope } from '@adminforge/expressions';

/**
 * Markdown fields (approval messages, manual-step instructions) are written by content authors, but the values their
 * `${ … }` expressions produce come from tenant data and inputs. Those values are escaped so they always show as text:
 * a display name like `[Click here](/admin)` can't become a link, and `# heading` can't become a heading.
 * The portal's Markdown renderers undo these backslash escapes (they support the CommonMark escapes).
 * Keep in step with `escapeMarkdown` in @adminforge/ui (the browser's copy).
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_[\]()]/g, '\\$&')
    .replace(
      /(^|\n)([ \t]*)([#>+-]|\d+[.)])/g,
      (_m, nl: string, sp: string, mark: string) => `${nl}${sp}${mark.slice(0, -1)}\\${mark.slice(-1)}`,
    );
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Renders a Markdown template: literal parts stay Markdown, every `${ … }` value is escaped (see escapeMarkdown). */
export async function renderMarkdown(source: string, scope: Scope): Promise<string> {
  let out = '';
  for (const seg of splitTemplate(source))
    out += seg.type === 'text' ? seg.value : escapeMarkdown(text(await evaluate(seg.source, scope)));
  return out;
}
