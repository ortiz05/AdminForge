import { Fragment, type ReactNode } from 'react';
import { cn, safeUrl } from '@adminforge/ui';

/**
 * A small, safe Markdown subset for runbook sections and manual-step instructions (§5.10: Markdown is rendered with
 * a sanitizer). Nothing is injected as HTML: the text becomes React elements, so markup in content stays text.
 * Supported: #–#### headings, paragraphs, - / * / 1. lists, > quotes, ``` fences, `code`, **bold**, *italic*,
 * [links](https://…) (http(s), mailto, in-app paths and #anchors only — see safeUrl), and backslash escapes (`\*`):
 * values the server interpolates into instructions and messages arrive escaped, so tenant data never becomes markup.
 */

/**
 * Inline tokens: 1 code, 2 an escaped character, 3 bold, 4 italic, 5 a link label and 6 its target. Linear in the text,
 * whatever it holds: each scan stops at the next delimiter of its own kind — code at the next "`", bold and italic at
 * the next "*", a label at the next "[" or "]" and a target at the next "(", ")" or whitespace — so no run of
 * delimiters makes one position scan what the next will scan again (as in the Markdown widget's tokenizer, S-21). A
 * label that could hold "[" made 64,000 "[" freeze the page for seconds. `[a [b](/x)` links "b"; a target with
 * parentheses needs them percent-encoded. Underscores are not emphasis here (instructions name settings like `AF_X_Y`).
 */
const INLINE =
  /`([^`]+)`|\\([!-/:-@[-`{-~])|\*\*((?:\\.|[^*\\])+)\*\*|\*([^*\s\\](?:\\.|[^*\\])*)\*|\[((?:\\.|[^[\]\\])+)\]\(([^()\s]+)\)/
    .source;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // A fresh expression per call: bold, italic and link labels are read again recursively.
  const re = new RegExp(INLINE, 'g');
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = re.lastIndex;
    const key = `${keyBase}-${i++}`;
    if (m[1] !== undefined)
      out.push(
        <code key={key} className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-xs text-fg">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined) out.push(m[2]);
    else if (m[3] !== undefined)
      out.push(
        <strong key={key} className="font-semibold text-fg">
          {inline(m[3], key)}
        </strong>,
      );
    else if (m[4] !== undefined) out.push(<em key={key}>{inline(m[4], key)}</em>);
    else {
      const target = safeUrl(m[6]!);
      const label = inline(m[5]!, key);
      out.push(
        target ? (
          <a
            key={key}
            href={target.href}
            className="font-medium text-accent underline-offset-2 hover:underline"
            {...(target.external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; lang: string };

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i]!);
      blocks.push({ kind: 'code', text: body.join('\n'), lang: fence[1] ?? '' });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1]!.length, text: h[2]! });
      continue;
    }
    const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = /\d/.test(li[1]!) ? 'ol' : 'ul';
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === kind) prev.items.push(li[2]!);
      else blocks.push({ kind, items: [li[2]!] });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'quote') prev.text += ` ${q[1]}`;
      else blocks.push({ kind: 'quote', text: q[1]! });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cn('flex flex-col gap-3 text-sm leading-relaxed text-fg-2', className)}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case 'h': {
            const cls =
              b.level <= 2 ? 'af-display text-md font-semibold text-fg' : 'text-sm font-semibold text-fg';
            return b.level <= 2 ? (
              <h3 key={k} className={cls}>
                {inline(b.text, k)}
              </h3>
            ) : (
              <h4 key={k} className={cls}>
                {inline(b.text, k)}
              </h4>
            );
          }
          case 'ul':
          case 'ol': {
            const List = b.kind;
            return (
              <List
                key={k}
                className={cn('flex flex-col gap-1 pl-5', b.kind === 'ul' ? 'list-disc' : 'list-decimal')}
              >
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`)}</li>
                ))}
              </List>
            );
          }
          case 'quote':
            return (
              <blockquote key={k} className="border-l-2 border-line-strong pl-3 text-fg-2">
                {inline(b.text, k)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={k}
                className="overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-xs text-fg-2"
                data-language={b.lang || undefined}
              >
                <code>{b.text}</code>
              </pre>
            );
          default:
            return <p key={k}>{inline(b.text, k)}</p>;
        }
      })}
    </div>
  );
}
