import type { ReactNode } from 'react';
import { safeUrl, type LinkComponent } from '@adminforge/ui';
import { tokenizeInline, type InlineToken } from './inline';

/**
 * A deliberately small Markdown subset for guidance text: headings, paragraphs, lists, code, emphasis and links.
 * It builds React elements directly — there is no HTML string and no `dangerouslySetInnerHTML`, so raw HTML in
 * content is shown as text. Links are limited to http(s), mailto, in-app paths and #anchors (safeUrl), and backslash
 * escapes (`\*`) show the character itself — values interpolated from data arrive escaped, so they stay text.
 */

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'rule' };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ') });
    para = [];
    if (list) blocks.push({ type: 'list', ...list });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith('```'); i++) code.push(lines[i]!);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (para.length) {
        blocks.push({ type: 'paragraph', text: para.join(' ') });
        para = [];
      }
      if (list && list.ordered !== ordered) {
        blocks.push({ type: 'list', ...list });
        list = null;
      }
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    if (list && /^\s{2,}/.test(line) && list.items.length) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    if (list) {
      blocks.push({ type: 'list', ...list });
      list = null;
    }
    para.push(trimmed);
  }
  flush();
  return blocks;
}

/** Only these link targets become links; anything else (javascript:, data:, `//host`, `/\host`, …) stays text. */
export const safeHref = safeUrl;

const LINK = 'font-medium text-accent underline underline-offset-2 hover:text-accent-strong';

function renderTokens(tokens: InlineToken[], Link: LinkComponent, keyPrefix: string): ReactNode[] {
  return tokens.map((t, n) => {
    const key = `${keyPrefix}-${n}`;
    switch (t.type) {
      case 'text':
        return t.text;
      case 'code':
        return (
          <code key={key} className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-xs text-fg">
            {t.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-fg">
            {renderTokens(t.children, Link, key)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderTokens(t.children, Link, key)}</em>;
      case 'link': {
        const target = safeHref(t.target);
        const label = renderTokens(t.children, Link, key);
        if (!target) return <span key={key}>{label}</span>;
        if (target.external)
          return (
            <a key={key} href={target.href} target="_blank" rel="noreferrer" className={LINK}>
              {label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          );
        return (
          <Link key={key} href={target.href} className={LINK}>
            {label}
          </Link>
        );
      }
    }
  });
}

/** Inline Markdown (code, strong, emphasis, links, escapes) as React elements; tokenized in linear time (inline.ts). */
export function renderInline(text: string, Link: LinkComponent, keyPrefix = 'i'): ReactNode[] {
  return renderTokens(tokenizeInline(text), Link, keyPrefix);
}

/**
 * Headings start at h3 (the page owns h1, panels own h2) and keep their relative depth: the shallowest heading in
 * the text becomes h3, whether the author wrote `#` or `##`, so levels never skip.
 */
const HEADING = ['h3', 'h4', 'h5'] as const;

export function Markdown({ source, Link }: { source: string; Link: LinkComponent }) {
  const blocks = parseBlocks(source);
  const top = Math.min(3, ...blocks.map((b) => (b.type === 'heading' ? b.level : 3)));
  return (
    <div className="flex max-w-3xl flex-col gap-3 text-sm leading-relaxed text-fg-2">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case 'heading': {
            const depth = b.level - top;
            const Tag = HEADING[Math.min(depth, HEADING.length - 1)]!;
            return (
              <Tag
                key={key}
                className={depth === 0 ? 'text-md font-semibold text-fg' : 'text-sm font-semibold text-fg'}
              >
                {renderInline(b.text, Link, key)}
              </Tag>
            );
          }
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={key}
                className={`flex flex-col gap-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-fg-3`}
              >
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, Link, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-md border border-line bg-sunken p-3 font-mono text-xs text-fg"
              >
                <code>{b.text}</code>
              </pre>
            );
          case 'rule':
            return <hr key={key} className="border-line" />;
          default:
            return <p key={key}>{renderInline(b.text, Link, key)}</p>;
        }
      })}
    </div>
  );
}
