import { useEffect, useMemo, useState } from 'react';
import { evaluate, splitTemplate, type Scope } from '@adminforge/expressions';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const looksLikeHtml = (s: string) => /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s);

/**
 * HTML from Microsoft APIs (message center posts, service health updates) → plain text with paragraph breaks.
 * Nothing is ever rendered as HTML: tags are dropped (block tags become line breaks, list items become "- ")
 * and entities decoded. Script/style contents are removed entirely.
 */
export function htmlToText(input: string): string {
  if (!looksLikeHtml(input)) return input;
  return input
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|li|tr|table|section|article|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?[a-z0-9]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k]!;
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
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
  for (const seg of splitTemplate(source)) out += seg.type === 'text' ? seg.value : toText(await evaluate(seg.source, scope));
  return out;
}

/**
 * Templated text (`markdown.text`): literal parts stay as written (they are Markdown), values from `${ … }` are
 * converted to plain text first, so HTML coming from data can never become markup.
 */
export function useInterpolatedText(source: string, scope: Scope): { text: string | undefined; error?: Error } {
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
